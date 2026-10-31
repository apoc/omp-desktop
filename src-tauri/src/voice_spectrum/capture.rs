//! The default microphone, read on a thread of its own: the cpal stream
//! fills a [`Ring`] and the same thread turns it into bands every
//! [`FRAME`]. The stream is created and dropped on that thread, so its
//! platform handle never crosses threads.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, Stream, StreamConfig};

use super::analysis::{Analyzer, Ring};

/// About 30 frames a second; the composer smooths between them.
const FRAME: Duration = Duration::from_millis(33);
/// How long a backend may take to open the device.
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);

/// A running capture; dropping it stops the stream and joins the thread.
pub struct Capture {
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    /// Opens the default input device and calls `emit` with `bands` fresh
    /// values every [`FRAME`] until dropped. Fails when there is no
    /// microphone or it cannot be opened (missing permission, device in
    /// exclusive use).
    pub fn start(bands: usize, emit: impl Fn(&[u8]) + Send + 'static) -> Result<Self, String> {
        let (stop, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("voice-spectrum".into())
            .spawn(move || {
                let (stream, ring, rate) = match open() {
                    Ok(opened) => opened,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e)); // the starter waits for exactly this
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                run(&ring, Analyzer::new(rate, bands), &stop_rx, &emit);
                drop(stream);
            })
            .map_err(|e| format!("could not start the voice spectrum thread: {e}"))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(thread),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err("the voice spectrum thread ended while opening the microphone".into())
            }
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Analyse and emit until told to stop (or the owner is gone).
fn run(
    ring: &Mutex<Ring>,
    mut analyzer: Analyzer,
    stop: &mpsc::Receiver<()>,
    emit: &impl Fn(&[u8]),
) {
    loop {
        match stop.recv_timeout(FRAME) {
            Err(RecvTimeoutError::Timeout) => {
                analyzer.load(&ring.lock().unwrap_or_else(PoisonError::into_inner));
                emit(analyzer.levels());
            }
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

type Opened = (Stream, Arc<Mutex<Ring>>, u32);

fn open() -> Result<Opened, String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or("no microphone found")?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("could not read the microphone's format: {e}"))?;
    let config = supported.config();
    let ring = Arc::new(Mutex::new(Ring::new()));
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, config, &ring),
        SampleFormat::F64 => build::<f64>(&device, config, &ring),
        SampleFormat::I8 => build::<i8>(&device, config, &ring),
        SampleFormat::I16 => build::<i16>(&device, config, &ring),
        SampleFormat::I32 => build::<i32>(&device, config, &ring),
        SampleFormat::U8 => build::<u8>(&device, config, &ring),
        SampleFormat::U16 => build::<u16>(&device, config, &ring),
        SampleFormat::U32 => build::<u32>(&device, config, &ring),
        other => return Err(format!("unsupported microphone sample format {other}")),
    }?;
    stream
        .play()
        .map_err(|e| format!("could not start the microphone: {e}"))?;
    Ok((stream, ring, config.sample_rate))
}

fn build<T>(
    device: &cpal::Device,
    config: StreamConfig,
    ring: &Arc<Mutex<Ring>>,
) -> Result<Stream, String>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    let ring = Arc::clone(ring); // the audio callback owns one handle
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                ring.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push_interleaved(data, channels);
            },
            |e| eprintln!("[omp-desktop] voice spectrum: microphone error: {e}"),
            Some(OPEN_TIMEOUT),
        )
        .map_err(|e| format!("could not open the microphone: {e}"))
}
