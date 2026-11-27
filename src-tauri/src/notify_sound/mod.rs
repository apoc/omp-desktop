//! Notification sounds: the webview sends a catalogue id and a volume, and
//! the sound is synthesised ([`synth`]) and played through `cpal` on a
//! short-lived thread that owns the stream, like `voice_spectrum/capture.rs`.
//! `WebKitGTK`'s own audio needs a `GStreamer` sink many installs lack, so the
//! webview plays nothing itself (`docs/architecture/notification-sounds.md`).

mod synth;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig, I24, U24};

use synth::Sound;

/// The stream's backend timeout: how long it waits on the platform for the
/// stream to activate. It does not bound opening the device (ALSA opens
/// without one). The playback thread also allows it for a device that starts
/// late before it gives up on hearing the sound end.
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);
/// Waited after the last sample for the device's buffer to drain.
const DRAIN: Duration = Duration::from_millis(250);

/// The newest sound's number: each `play` takes the next one, and a stream
/// whose number is no longer current falls silent, so the newest sound wins.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Plays catalogue sound `sound` at `volume` (`0..=100`, more is read as
/// 100) and returns at once. A sound that is still playing is cut off by
/// the new one; volume 0 plays nothing and cuts nothing. Fails for an id
/// outside the catalogue, or when the playback thread cannot start; a
/// missing or failing audio device only shows in the log, on that thread.
pub fn play(sound: &str, volume: u8) -> Result<(), String> {
    play_with(&GENERATION, sound, volume)
}

fn play_with(generation: &'static AtomicU64, sound: &str, volume: u8) -> Result<(), String> {
    let sound =
        synth::find(sound).ok_or_else(|| format!("unknown notification sound '{sound}'"))?;
    if volume == 0 {
        return Ok(());
    }
    let mine = generation.fetch_add(1, Ordering::AcqRel) + 1;
    thread::Builder::new()
        .name("notify-sound".into())
        .spawn(move || {
            if let Err(e) = run(sound, volume, generation, mine) {
                eprintln!("[omp-desktop] notify sound: {e}");
            }
        })
        .map(drop)
        .map_err(|e| format!("could not start the sound thread: {e}"))
}

/// Opens the default output, plays the sound to its end (or until a newer
/// one replaces it) and closes the stream, all on the calling thread.
fn run(sound: &Sound, volume: u8, generation: &'static AtomicU64, mine: u64) -> Result<(), String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or("no audio output found")?;
    let supported = device
        .default_output_config()
        .map_err(|e| format!("could not read the output's format: {e}"))?;
    let config = supported.config();
    let samples = synth::render(sound, config.sample_rate, synth::gain(volume));
    if mine != generation.load(Ordering::Acquire) {
        return Ok(());
    }
    let (done, finished) = mpsc::sync_channel(1);
    let player = Player {
        samples,
        at: 0,
        generation,
        mine,
        done,
    };
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, config, player),
        SampleFormat::F64 => build::<f64>(&device, config, player),
        SampleFormat::I8 => build::<i8>(&device, config, player),
        SampleFormat::I16 => build::<i16>(&device, config, player),
        SampleFormat::I24 => build::<I24>(&device, config, player),
        SampleFormat::I32 => build::<i32>(&device, config, player),
        SampleFormat::I64 => build::<i64>(&device, config, player),
        SampleFormat::U8 => build::<u8>(&device, config, player),
        SampleFormat::U16 => build::<u16>(&device, config, player),
        SampleFormat::U24 => build::<U24>(&device, config, player),
        SampleFormat::U32 => build::<u32>(&device, config, player),
        SampleFormat::U64 => build::<u64>(&device, config, player),
        other => return Err(format!("unsupported output sample format {other}")),
    }?;
    stream
        .play()
        .map_err(|e| format!("could not start the output: {e}"))?;
    // The callback says when the last sample (or the silence of a replaced
    // sound) is written; a device that never calls back times out.
    let _ = finished.recv_timeout(Duration::from_secs_f32(sound.end()) + OPEN_TIMEOUT);
    if mine == generation.load(Ordering::Acquire) {
        thread::sleep(DRAIN);
    }
    Ok(())
}

/// What the audio callback owns.
struct Player {
    samples: Vec<f32>,
    /// Frames written so far.
    at: usize,
    generation: &'static AtomicU64,
    mine: u64,
    /// Told (without blocking) once everything is written.
    done: SyncSender<()>,
}

impl Player {
    /// Fills `data` with the sound's next frames, each sample on every one
    /// of `channels`, then silence; silence throughout once a newer sound
    /// has replaced this one. Tells `done` when the sound is over.
    fn fill<T: Sample + FromSample<f32>>(&mut self, data: &mut [T], channels: usize) {
        let replaced = self.mine != self.generation.load(Ordering::Acquire);
        for frame in data.chunks_mut(channels) {
            let sample = if replaced {
                0.0
            } else {
                self.samples.get(self.at).copied().unwrap_or(0.0)
            };
            self.at = self.at.saturating_add(1);
            frame.fill(T::from_sample(sample));
        }
        if replaced || self.at >= self.samples.len() {
            // Full only if already told: nothing more to say.
            let _ = self.done.try_send(());
        }
    }
}

/// A stream that plays `player` through the device.
fn build<T>(
    device: &cpal::Device,
    config: StreamConfig,
    mut player: Player,
) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let channels = usize::from(config.channels);
    device
        .build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], _| player.fill(data, channels),
            |e| eprintln!("[omp-desktop] notify sound: output error: {e}"),
            Some(OPEN_TIMEOUT),
        )
        .map_err(|e| format!("could not open the output: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_sound_is_an_error_and_replaces_nothing() {
        static GEN: AtomicU64 = AtomicU64::new(7);
        let err = play_with(&GEN, "gong", 60).expect_err("unknown id");
        assert!(err.contains("gong"), "{err}");
        assert_eq!(GEN.load(Ordering::Acquire), 7);
    }

    #[test]
    fn volume_zero_plays_nothing_and_cuts_nothing() {
        static GEN: AtomicU64 = AtomicU64::new(7);
        assert_eq!(play_with(&GEN, "chime", 0), Ok(()));
        assert_eq!(GEN.load(Ordering::Acquire), 7);
        assert_eq!(GENERATION.load(Ordering::Acquire), 0);
    }

    fn player(samples: &[f32], generation: &'static AtomicU64) -> (Player, mpsc::Receiver<()>) {
        let (done, told) = mpsc::sync_channel(1);
        let player = Player {
            samples: samples.to_vec(),
            at: 0,
            generation,
            mine: generation.load(Ordering::Acquire),
            done,
        };
        (player, told)
    }

    #[test]
    fn the_player_writes_each_sample_to_every_channel_then_silence() {
        static GEN: AtomicU64 = AtomicU64::new(1);
        let (mut player, told) = player(&[0.25, 0.5, -0.5], &GEN);
        let mut data = [9.0_f32; 4];
        player.fill(&mut data, 2);
        assert_eq!(data, [0.25, 0.25, 0.5, 0.5]);
        assert!(told.try_recv().is_err(), "told before the last sample");
        player.fill(&mut data, 2);
        assert_eq!(data, [-0.5, -0.5, 0.0, 0.0]);
        assert!(told.try_recv().is_ok(), "not told after the last sample");
    }

    #[test]
    fn a_newer_sound_silences_the_player_and_ends_it() {
        static GEN: AtomicU64 = AtomicU64::new(1);
        let (mut player, told) = player(&[0.25; 100], &GEN);
        let mut data = [9.0_f32; 4];
        player.fill(&mut data, 2);
        assert_eq!(data, [0.25; 4]);
        assert!(told.try_recv().is_err());
        GEN.fetch_add(1, Ordering::AcqRel);
        player.fill(&mut data, 2);
        assert_eq!(data, [0.0; 4]);
        assert!(
            told.try_recv().is_ok(),
            "a replaced sound must say it is over"
        );
    }
}
