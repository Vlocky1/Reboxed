// 16-bit PCM WAV helpers (sampler captures, recordings).

/** 44-byte RIFF/WAVE header for 16-bit PCM. */
export function wavHeader(dataBytes, sampleRate, channels) {
  const v = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  return new Uint8Array(v.buffer);
}

/** Interleave float channels into 16-bit little-endian PCM. */
export function floatToPcm16(channels, start = 0, end = channels[0].length) {
  const n = end - start;
  const ch = channels.length;
  const out = new Int16Array(n * ch);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][start + i]));
      out[i * ch + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return out;
}

/** Complete WAV file from float channels (optionally a frame range). */
export function encodeWav(channels, sampleRate, start, end) {
  const pcm = floatToPcm16(channels, start, end);
  const bytes = new Uint8Array(44 + pcm.byteLength);
  bytes.set(wavHeader(pcm.byteLength, sampleRate, channels.length), 0);
  bytes.set(new Uint8Array(pcm.buffer), 44);
  return bytes;
}
