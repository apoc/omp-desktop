//! Equalizer bands from microphone samples: the newest [`FFT_SIZE`] mono
//! samples, Hann-windowed, through a real FFT, folded into [`BANDS`]
//! log-spaced bands over the voice range and mapped from dBFS to `0..=255`.

use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

/// Bars the composer draws.
pub const BANDS: usize = 32;
/// About 85 ms at 48 kHz: fine enough for 12 Hz bins under the lowest bands.
pub const FFT_SIZE: usize = 4096;
/// The voice range shown: below 80 Hz is mostly hum, above 8 kHz sibilance.
const LOW_HZ: f32 = 80.0;
const HIGH_HZ: f32 = 8_000.0;
/// dBFS shown as an empty and as a full bar (after the tilt below).
const FLOOR_DB: f32 = -85.0;
const CEIL_DB: f32 = -25.0;
/// Speech loses about 6 dB per octave towards the treble; lifting each band
/// by this much per octave above 1 kHz (and lowering it below) keeps the
/// display from leaning on its bass half.
const TILT_DB_PER_OCTAVE: f32 = 4.5;

/// The newest [`FFT_SIZE`] samples, oldest first once full; a capture
/// callback pushes, the analysis thread reads.
pub struct Ring {
    samples: Vec<f32>,
    /// The slot the next sample goes to; also the oldest sample once full.
    next: usize,
}

impl Ring {
    pub fn new() -> Self {
        Self {
            samples: vec![0.0; FFT_SIZE],
            next: 0,
        }
    }

    pub fn push(&mut self, sample: f32) {
        self.samples[self.next] = sample;
        self.next = (self.next + 1) % FFT_SIZE;
    }

    /// Mixes interleaved `frames` of `channels` samples down to mono.
    pub fn push_interleaved(&mut self, frames: &[f32], channels: usize) {
        let channels = channels.max(1);
        #[allow(clippy::cast_precision_loss)] // a channel count, far below 2^23
        let scale = 1.0 / channels as f32;
        for frame in frames.chunks_exact(channels) {
            self.push(frame.iter().sum::<f32>() * scale);
        }
    }

    /// Oldest to newest.
    fn ordered(&self) -> impl Iterator<Item = f32> + '_ {
        self.samples[self.next..]
            .iter()
            .chain(&self.samples[..self.next])
            .copied()
    }
}

pub struct Analyzer {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    /// Each band's bins `start..end` and its tilt in dB.
    bands: [(usize, usize, f32); BANDS],
    /// Turns a bin magnitude into the amplitude of the sine behind it.
    norm: f32,
}

impl Analyzer {
    pub fn new(sample_rate: u32) -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        #[allow(clippy::cast_precision_loss)] // FFT_SIZE is a small power of two
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| {
                let phase = std::f32::consts::TAU * i as f32 / (FFT_SIZE - 1) as f32;
                0.5_f32.mul_add(-phase.cos(), 0.5)
            })
            .collect();
        let norm = 2.0 / window.iter().sum::<f32>();
        Self {
            input: fft.make_input_vec(),
            spectrum: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
            window,
            bands: band_layout(sample_rate),
            norm,
        }
    }

    /// The bands of the ring's current contents, `0..=255` each.
    pub fn bands(&mut self, ring: &Ring, out: &mut [u8; BANDS]) {
        for ((slot, sample), w) in self.input.iter_mut().zip(ring.ordered()).zip(&self.window) {
            *slot = sample * w;
        }
        if self
            .fft
            .process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch)
            .is_err()
        {
            // Only a buffer length mismatch fails, and they come from the plan.
            out.fill(0);
            return;
        }
        for (value, &(start, end, tilt)) in out.iter_mut().zip(&self.bands) {
            let peak = self.spectrum[start..end]
                .iter()
                .map(|c| c.norm())
                .fold(0.0_f32, f32::max);
            *value = level(peak * self.norm, tilt);
        }
    }
}

/// `amplitude` (1.0 = full scale) as a bar height.
fn level(amplitude: f32, tilt_db: f32) -> u8 {
    if amplitude <= 0.0 {
        return 0;
    }
    let db = 20.0_f32.mul_add(amplitude.log10(), tilt_db);
    let unit = ((db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)).clamp(0.0, 1.0);
    // In 0..=255 after the clamp.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let byte = (unit * 255.0).round() as u8;
    byte
}

/// Log-spaced bands between [`LOW_HZ`] and [`HIGH_HZ`] (or just under
/// Nyquist), each at least one bin wide.
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn band_layout(sample_rate: u32) -> [(usize, usize, f32); BANDS] {
    let rate = sample_rate.max(8_000) as f32;
    let bin_hz = rate / FFT_SIZE as f32;
    let high = HIGH_HZ.min(rate * 0.45);
    let ratio = high / LOW_HZ;
    let last_bin = FFT_SIZE / 2;
    let mut layout = [(0, 0, 0.0); BANDS];
    for (k, band) in layout.iter_mut().enumerate() {
        let lo = LOW_HZ * ratio.powf(k as f32 / BANDS as f32);
        let hi = LOW_HZ * ratio.powf((k + 1) as f32 / BANDS as f32);
        let start = ((lo / bin_hz).round() as usize).clamp(1, last_bin);
        let end = ((hi / bin_hz).round() as usize).clamp(start + 1, last_bin + 1);
        let center = (lo * hi).sqrt();
        *band = (start, end, TILT_DB_PER_OCTAVE * (center / 1_000.0).log2());
    }
    layout
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn ring_of(signal: impl Fn(f32) -> f32) -> Ring {
        let mut ring = Ring::new();
        for i in 0..FFT_SIZE * 2 {
            #[allow(clippy::cast_precision_loss)]
            ring.push(signal(i as f32 / RATE as f32));
        }
        ring
    }

    fn sine(hz: f32, amplitude: f32) -> impl Fn(f32) -> f32 {
        move |t| amplitude * (std::f32::consts::TAU * hz * t).sin()
    }

    fn bands_of(ring: &Ring) -> [u8; BANDS] {
        let mut out = [0; BANDS];
        Analyzer::new(RATE).bands(ring, &mut out);
        out
    }

    #[allow(clippy::cast_precision_loss)] // test constants, exact in f32
    fn band_of(hz: f32) -> usize {
        let bin_hz = RATE as f32 / FFT_SIZE as f32;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let bin = (hz / bin_hz).round() as usize;
        band_layout(RATE)
            .iter()
            .position(|&(s, e, _)| (s..e).contains(&bin))
            .unwrap()
    }

    #[test]
    fn silence_is_an_empty_display() {
        assert_eq!(bands_of(&Ring::new()), [0; BANDS]);
    }

    #[test]
    fn a_tone_lights_its_own_band_and_leaves_distant_ones_dark() {
        let out = bands_of(&ring_of(sine(1_000.0, 0.1)));
        let lit = band_of(1_000.0);
        assert_eq!(
            out.iter().enumerate().max_by_key(|&(_, v)| *v).unwrap().0,
            lit
        );
        assert!(
            out[lit] > 200,
            "a -20 dBFS tone is near the top: {}",
            out[lit]
        );
        assert!(out[lit + 6] < out[lit] / 4, "{out:?}");
        assert!(out[lit - 6] < out[lit] / 4, "{out:?}");
    }

    #[test]
    fn louder_input_draws_taller_bars_until_full_scale() {
        let quiet = bands_of(&ring_of(sine(500.0, 0.001)));
        let loud = bands_of(&ring_of(sine(500.0, 0.03)));
        let band = band_of(500.0);
        assert!(quiet[band] < loud[band], "{} < {}", quiet[band], loud[band]);
        assert_eq!(bands_of(&ring_of(sine(500.0, 1.0)))[band], 255);
    }

    #[test]
    fn bands_rise_through_the_voice_range_without_gaps_or_overlaps() {
        for rate in [16_000, 44_100, 48_000, 96_000] {
            let layout = band_layout(rate);
            for pair in layout.windows(2) {
                assert!(pair[0].0 < pair[0].1, "{rate}: empty band {pair:?}");
                assert!(pair[0].0 <= pair[1].0, "{rate}: bands go down {pair:?}");
            }
            assert!(
                layout[BANDS - 1].1 <= FFT_SIZE / 2 + 1,
                "{rate}: past Nyquist"
            );
        }
    }

    #[test]
    fn stereo_is_mixed_down_and_the_ring_keeps_the_newest_samples() {
        let mut ring = Ring::new();
        ring.push_interleaved(&[1.0, 0.0, 0.5, 0.5], 2);
        let tail: Vec<f32> = ring.ordered().skip(FFT_SIZE - 2).collect();
        assert_eq!(tail, [0.5, 0.5]);
        for _ in 0..FFT_SIZE {
            ring.push(0.25);
        }
        assert!(ring.ordered().all(|s| (s - 0.25).abs() < f32::EPSILON));
    }
}
