// MP3 encoding of interleaved 16-bit stereo PCM (stems are stored as MP3 to save space).
// Encoder: lamejs (LGPL-3.0, pure JavaScript port of LAME).
import { Mp3Encoder } from '@breezystack/lamejs';

/** Samples the decoder outputs before the first real sample (LAME: 576 + 529 decoder delay). */
export const MP3_DELAY = 1105;

/**
 * @param {Int16Array} pcm interleaved stereo
 * @param {number} rate sample rate
 * @param {number} kbps constant bitrate
 * @returns {Uint8Array}
 */
export function encodeMp3(pcm, rate, kbps = 256) {
  const enc = new Mp3Encoder(2, rate, kbps);
  const BLOCK = 1152 * 16;
  const left = new Int16Array(BLOCK);
  const right = new Int16Array(BLOCK);
  const parts = [];
  let size = 0;
  const frames = pcm.length >> 1;
  for (let i = 0; i < frames; i += BLOCK) {
    const n = Math.min(BLOCK, frames - i);
    for (let k = 0; k < n; k++) { left[k] = pcm[2 * (i + k)]; right[k] = pcm[2 * (i + k) + 1]; }
    const out = enc.encodeBuffer(left.subarray(0, n), right.subarray(0, n));
    if (out.length) { parts.push(new Uint8Array(out)); size += out.length; }
  }
  const end = enc.flush();
  if (end.length) { parts.push(new Uint8Array(end)); size += end.length; }
  const mp3 = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { mp3.set(p, o); o += p.length; }
  return mp3;
}
