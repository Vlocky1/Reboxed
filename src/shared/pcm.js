// Low memory mode: a deck keeps its track in 16 bits instead of 32 (115 -> 58 MB for 5 minutes).
// Decoded audio can go above full scale (hot masters, MP3 overshoots), so the range is 1.5 times full
// scale: nothing clips before the mixer's limiter, for 0.6 bit less precision (about -86 dB).

const HEADROOM = 1.5;

/** Multiply a stored 16-bit sample by this to get the audio back (sent to the deck worklet). */
export const COMPACT_SCALE = HEADROOM / 32767;

/** @param {Float32Array} samples @returns {Int16Array} */
export function toCompactPcm(samples) {
  const out = new Int16Array(samples.length);
  const k = 32767 / HEADROOM;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * k;
    out[i] = v > 32767 ? 32767 : v < -32767 ? -32767 : Math.round(v);
  }
  return out;
}

/** Automatic low memory mode: computers with 8 GB or less (they report a little under their size). */
export const lowMemoryWanted = (mode, ramGB) => mode === 'on' || (mode !== 'off' && ramGB > 0 && ramGB <= 8.5);
