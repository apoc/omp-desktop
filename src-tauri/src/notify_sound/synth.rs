//! The sound catalogue and its renderer: every notification sound is a few
//! oscillator tones with a short attack and an exponential decay, rendered
//! to mono samples at the output device's rate. Nothing ships as audio data.

use std::f32::consts::TAU;

/// How loud a sound is at volume 100: the RMS of its loudest
/// [`LOUDNESS_WINDOW`], as a fraction of full scale (about -16 dBFS).
/// Sounds are matched by RMS, not peak, because a peak says little about
/// how loud a short pluck is next to a held note.
const TARGET_RMS: f32 = 0.16;
/// The longest stretch the ear sums into one loudness, in seconds.
const LOUDNESS_WINDOW: f32 = 0.2;
/// The peak a sound may reach, whatever the target asks; it keeps the loud,
/// spiky sounds clear of clipping.
pub const PEAK_LIMIT: f32 = 0.95;
/// Linear fade-in of every tone, so it starts without a click.
const ATTACK: f32 = 0.005;
/// What a tone's envelope has decayed to at its end.
const DECAY_FLOOR: f32 = 1e-3;
/// How hard the soft square's `tanh` squeezes the sine.
const SOFT_DRIVE: f32 = 3.0;

#[derive(Clone, Copy)]
enum Wave {
    Sine,
    Triangle,
    SoftSquare,
}

impl Wave {
    /// One cycle at `phase` in `0..1`, starting at zero, within `-1..=1`.
    fn at(self, phase: f32) -> f32 {
        match self {
            Self::Sine => (phase * TAU).sin(),
            Self::Triangle => (-4.0_f32).mul_add(((phase + 0.25).fract() - 0.5).abs(), 1.0),
            Self::SoftSquare => (SOFT_DRIVE * (phase * TAU).sin()).tanh() / SOFT_DRIVE.tanh(),
        }
    }
}

/// One oscillator: sounds from `start` for `duration` seconds.
struct Tone {
    wave: Wave,
    start: f32,
    duration: f32,
    /// Hz at the start.
    freq: f32,
    /// Hz at the end, reached by an exponential glide; `None` holds `freq`.
    glide: Option<f32>,
    /// Loudness relative to the sound's other tones.
    gain: f32,
}

const fn tone(wave: Wave, start: f32, duration: f32, freq: f32, gain: f32) -> Tone {
    Tone {
        wave,
        start,
        duration,
        freq,
        glide: None,
        gain,
    }
}

pub struct Sound {
    pub id: &'static str,
    tones: &'static [Tone],
}

impl Sound {
    /// Seconds until the last tone has decayed.
    pub fn end(&self) -> f32 {
        self.tones
            .iter()
            .map(|t| t.start + t.duration)
            .fold(0.0, f32::max)
    }
}

/// The catalogue sound called `id`.
pub fn find(id: &str) -> Option<&'static Sound> {
    SOUNDS.iter().find(|s| s.id == id)
}

/// The catalogue, in the order of `SOUNDS` in `src/app/notify-sound.js`
/// (a test keeps the two in step).
pub const SOUNDS: &[Sound] = &[
    // Two ascending notes.
    Sound {
        id: "chime",
        tones: &[
            tone(Wave::Sine, 0.0, 0.35, 880.0, 1.0),
            tone(Wave::Sine, 0.12, 0.5, 1318.5, 0.8),
        ],
    },
    // A struck bell: a low strike over inharmonic partials that die sooner.
    Sound {
        id: "bell",
        tones: &[
            tone(Wave::Sine, 0.0, 0.9, 660.0, 1.0),
            tone(Wave::Sine, 0.0, 0.6, 1821.6, 0.5),
            tone(Wave::Sine, 0.0, 0.35, 3564.0, 0.25),
            tone(Wave::Sine, 0.0, 0.2, 5893.8, 0.12),
        ],
    },
    // A bubble: one quick downward glide.
    Sound {
        id: "pop",
        tones: &[Tone {
            glide: Some(150.0),
            ..tone(Wave::Sine, 0.0, 0.12, 600.0, 1.0)
        }],
    },
    // Two short low hits.
    Sound {
        id: "knock",
        tones: &[
            tone(Wave::Triangle, 0.0, 0.12, 240.0, 1.0),
            tone(Wave::Triangle, 0.16, 0.14, 200.0, 0.8),
        ],
    },
    // A major arpeggio, C5 E5 G5.
    Sound {
        id: "rise",
        tones: &[
            tone(Wave::Sine, 0.0, 0.25, 523.25, 0.8),
            tone(Wave::Sine, 0.1, 0.25, 659.25, 0.9),
            tone(Wave::Sine, 0.2, 0.45, 783.99, 1.0),
        ],
    },
    // One short, soft beep.
    Sound {
        id: "blip",
        tones: &[tone(Wave::SoftSquare, 0.0, 0.09, 1000.0, 1.0)],
    },
];

/// The loudness target for a volume of `0..=100` (more is read as 100): the
/// RMS a sound reaches, on a `v^1.5` curve so the slider's steps sound even
/// and the quiet end stays audible.
pub fn gain(volume: u8) -> f32 {
    (f32::from(volume.min(100)) / 100.0).powf(1.5) * TARGET_RMS
}

/// `sound` as mono samples at `sample_rate`, scaled so the RMS of its loudest
/// [`LOUDNESS_WINDOW`] is `gain` (silence at 0), unless that would take the
/// peak past [`PEAK_LIMIT`]; then the peak sets the scale.
pub fn render(sound: &Sound, sample_rate: u32, gain: f32) -> Vec<f32> {
    // Exact for any real rate (below 2^24).
    #[allow(clippy::cast_precision_loss)]
    let rate = sample_rate as f32;
    // Truncation intended: a sound is a whole number of samples.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (len, window) = (
        (sound.end() * rate).round() as usize,
        ((LOUDNESS_WINDOW * rate).round() as usize).max(1),
    );
    let mut out = vec![0.0_f32; len];
    for t in sound.tones {
        mix(t, rate, &mut out);
    }
    let peak = out.iter().fold(0.0_f32, |p, s| p.max(s.abs()));
    let (mut sum, mut loudest) = (0.0_f64, 0.0_f64);
    for (i, s) in out.iter().enumerate() {
        sum += f64::from(*s).powi(2);
        if let Some(gone) = i.checked_sub(window).map(|g| out[g]) {
            sum -= f64::from(gone).powi(2);
        }
        loudest = loudest.max(sum);
    }
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    let rms = (loudest / window as f64).sqrt() as f32;
    let scale = if peak > 0.0 && rms > 0.0 {
        (gain / rms).min(PEAK_LIMIT / peak)
    } else {
        0.0
    };
    for s in &mut out {
        *s *= scale;
    }
    out
}

/// Adds `t` to `out` from its start offset on.
fn mix(t: &Tone, rate: f32, out: &mut [f32]) {
    // Truncation intended: sample indices.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (first, count) = (
        (t.start * rate).round() as usize,
        (t.duration * rate) as usize,
    );
    let end_freq = t.glide.unwrap_or(t.freq);
    let ratio = end_freq / t.freq;
    let decay = 1.0 / (t.duration - ATTACK);
    let mut phase = 0.0_f32;
    for (n, slot) in out.iter_mut().skip(first).take(count).enumerate() {
        // A sample index within one second of sound: exact.
        #[allow(clippy::cast_precision_loss)]
        let secs = n as f32 / rate;
        let progress = secs / t.duration;
        let attack = (secs / ATTACK).min(1.0);
        let env = attack * DECAY_FLOOR.powf(((secs - ATTACK) * decay).max(0.0));
        *slot = (t.gain * env).mul_add(t.wave.at(phase), *slot);
        phase = (phase + t.freq * ratio.powf(progress) / rate).fract();
    }
}

#[cfg(test)]
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
mod tests {
    use super::*;

    const RATES: [u32; 2] = [44_100, 48_000];

    fn sound(id: &str) -> &'static Sound {
        find(id).expect(id)
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0, |p, s| p.max(s.abs()))
    }

    /// RMS of the loudest 200 ms, by prefix sums apart from `render`'s loop.
    fn loudest_rms(samples: &[f32], rate: u32) -> f64 {
        let window = (rate / 5) as usize;
        let mut prefix = vec![0.0_f64];
        for s in samples {
            let s = f64::from(*s);
            prefix.push(s.mul_add(s, prefix[prefix.len() - 1]));
        }
        let best = (1..prefix.len())
            .map(|end| prefix[end] - prefix[end.saturating_sub(window)])
            .fold(0.0, f64::max);
        (best / window as f64).sqrt()
    }

    fn db(ratio: f64) -> f64 {
        20.0 * ratio.log10()
    }

    #[test]
    fn every_sound_renders_at_the_recipe_length_in_both_common_rates() {
        for rate in RATES {
            for sound in SOUNDS {
                let samples = render(sound, rate, 0.1);
                let end = sound
                    .tones
                    .iter()
                    .map(|t| f64::from(t.start) + f64::from(t.duration))
                    .fold(0.0, f64::max);
                let want = (end * f64::from(rate)).round() as usize;
                assert!(
                    samples.len().abs_diff(want) <= 1,
                    "{} at {rate}: {} samples, recipe says {want}",
                    sound.id,
                    samples.len()
                );
                let secs = samples.len() as f32 / rate as f32;
                assert!((0.05..1.0).contains(&secs), "{} lasts {secs} s", sound.id);
            }
        }
    }

    /// The ids whose peak limit, not the volume target, set their scale.
    fn limited_at(volume: u8) -> Vec<&'static str> {
        let mut limited = Vec::new();
        for sound in SOUNDS {
            let samples = render(sound, 48_000, gain(volume));
            let rms = loudest_rms(&samples, 48_000);
            let target = f64::from(gain(volume));
            assert!(peak(&samples) <= PEAK_LIMIT + 1e-6, "{} clips", sound.id);
            if (peak(&samples) - PEAK_LIMIT).abs() < 1e-4 {
                assert!(rms < target, "{} limited yet at its target", sound.id);
                limited.push(sound.id);
            } else {
                let error = db(rms / target).abs();
                assert!(error < 0.1, "{} at {volume}: {error:.2} dB off", sound.id);
            }
        }
        limited
    }

    #[test]
    fn the_loudest_200ms_hits_the_volume_target_for_every_sound() {
        assert!(limited_at(60).is_empty(), "the default volume is limited");
        assert_eq!(limited_at(100), ["pop"], "only the spikiest is limited");
    }

    #[test]
    fn the_peak_limit_wins_over_a_target_it_would_break() {
        let chime = sound("chime");
        // A target far above anything the volume curve asks for.
        let samples = render(chime, 48_000, 0.9);
        assert!(
            (peak(&samples) - PEAK_LIMIT).abs() < 1e-4,
            "{}",
            peak(&samples)
        );
        assert!(loudest_rms(&samples, 48_000) < 0.9);
    }

    #[test]
    fn the_edges_are_silent_and_the_start_ramps_in() {
        for rate in RATES {
            for sound in SOUNDS {
                let samples = render(sound, rate, gain(100));
                let first = samples[0];
                let last = samples[samples.len() - 1];
                assert!(first.abs() < 1e-3, "{} starts at {first}", sound.id);
                assert!(last.abs() < 1e-3, "{} ends at {last}", sound.id);
                // The attack ramp: a millisecond in, a tone is still a
                // fifth of the way up (plus mixing slack).
                let early = peak(&samples[..(rate / 1000) as usize]);
                let top = peak(&samples);
                assert!(early < 0.3 * top, "{} has no attack: {early}", sound.id);
            }
        }
    }

    #[test]
    fn zero_gain_renders_silence() {
        assert!(render(sound("chime"), 48_000, 0.0)
            .iter()
            .all(|s| *s == 0.0));
    }

    #[test]
    fn an_unknown_id_is_not_in_the_catalogue() {
        assert!(find("gong").is_none());
        assert!(find("").is_none());
    }

    #[test]
    fn gain_is_perceptual_and_capped() {
        assert!(gain(0).abs() < f32::EPSILON);
        assert!((gain(100) - TARGET_RMS).abs() < f32::EPSILON);
        assert!((gain(250) - gain(100)).abs() < f32::EPSILON);
        assert!((gain(25) / TARGET_RMS - 0.125).abs() < 1e-6);
    }

    #[test]
    fn the_sounds_differ_pairwise() {
        let rendered: Vec<Vec<f32>> = SOUNDS.iter().map(|s| render(s, 48_000, gain(60))).collect();
        for (i, a) in rendered.iter().enumerate() {
            for (j, b) in rendered.iter().enumerate().skip(i + 1) {
                let n = a.len().min(b.len());
                let diff: f32 = a[..n].iter().zip(&b[..n]).map(|(x, y)| (x - y).abs()).sum();
                assert!(
                    diff / n as f32 > 0.005 || a.len().abs_diff(b.len()) > 2_000,
                    "{} and {} sound alike",
                    SOUNDS[i].id,
                    SOUNDS[j].id
                );
            }
        }
    }

    /// The webview's picker lists the same ids in the same order; an id the
    /// webview offers and Rust lacks would be an error on every play.
    #[test]
    fn the_catalogue_matches_the_webview_list() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/app/notify-sound.js"
        ))
        .expect("read src/app/notify-sound.js");
        let start = source
            .find("const SOUNDS = Object.freeze([")
            .expect("the SOUNDS literal");
        let list = &source[start..];
        let list = &list[..list.find(']').expect("end of the SOUNDS literal")];
        let ids: Vec<&str> = list
            .match_indices("id:")
            .filter_map(|(idx, m)| {
                let rest = list[idx + m.len()..].trim_start();
                let quote = rest.chars().next().filter(|c| matches!(c, '"' | '\''))?;
                let name = &rest[1..];
                Some(&name[..name.find(quote)?])
            })
            .collect();
        assert!(!ids.is_empty(), "no ids found in the SOUNDS literal");
        let ours: Vec<&str> = SOUNDS.iter().map(|s| s.id).collect();
        assert_eq!(ids, ours, "SOUNDS in src/app/notify-sound.js");
    }
}
