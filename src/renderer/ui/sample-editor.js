// Sampler slot editor: name, trim (drag the start / end handles on the waveform, preview), mode,
// tempo sync, BPM and gain. Trimming writes a new WAV next to the other samples.
import { h, modal } from './dom.js';

/**
 * @param {object} app
 * @param {number} i slot index
 * @returns {Promise<boolean>} true when the slot was changed
 */
export async function editSample(app, i) {
  const sampler = app.sampler;
  const s = sampler.slots[i];
  if (!s.buffer) return false;
  const buf = s.buffer;
  const dur = buf.duration;
  let start = 0; let end = dur;
  const canvas = h('canvas.se-wave');
  const times = h('div.se-times');
  const name = h('input.text', { value: s.name, spellcheck: false });
  const mode = h('select', {}, h('option', { value: 'oneshot', selected: s.mode === 'oneshot' }, 'One shot'), h('option', { value: 'loop', selected: s.mode === 'loop' }, 'Loop'));
  const sync = h('input', { type: 'checkbox', checked: !!s.sync });
  const bpm = h('input.text', { type: 'number', step: '0.01', min: 0, value: s.bpm ? s.bpm.toFixed(2) : '' });
  const gainVal = h('span.dim');
  const gain = h('input', { type: 'range', min: 0, max: 2, step: 0.01, value: s.gain });
  const showGain = () => { gainVal.textContent = ` ${Math.round(gain.value * 100)} %`; };
  gain.addEventListener('input', showGain); showGain();

  // Peaks once, then draw with the trim area.
  const peaks = (() => {
    const n = 600; const L = buf.getChannelData(0); const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const out = new Float32Array(n); const step = L.length / n;
    for (let p = 0; p < n; p++) { let m = 0; for (let j = Math.floor(p * step); j < Math.floor((p + 1) * step); j++) m = Math.max(m, Math.abs(L[j]), Math.abs(R[j])); out[p] = m; }
    return out;
  })();
  const fmt = (t) => `${t.toFixed(2)} s`;
  const draw = () => {
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)); const hh = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, hh);
    const xa = (start / dur) * w; const xb = (end / dur) * w;
    for (let x = 0; x < w; x++) {
      const v = peaks[Math.floor((x / w) * peaks.length)] * hh * 0.45;
      g.fillStyle = x >= xa && x <= xb ? '#a24dff' : 'rgba(255,255,255,.18)';
      g.fillRect(x, hh / 2 - v, 1, v * 2 || 1);
    }
    g.fillStyle = '#fff';
    for (const x of [xa, xb]) { g.fillRect(x - dpr, 0, 2 * dpr, hh); g.fillRect(x - 5 * dpr, 0, 10 * dpr, 6 * dpr); }
    times.textContent = `Start ${fmt(start)} · End ${fmt(end)} · Length ${fmt(end - start)}`;
  };
  let dragging = null;
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect(); const t = ((e.clientX - r.left) / r.width) * dur;
    dragging = Math.abs(t - start) < Math.abs(t - end) ? 'start' : 'end';
    canvas.setPointerCapture(e.pointerId);
    move(e);
  });
  const move = (e) => {
    if (!dragging) return;
    const r = canvas.getBoundingClientRect(); const t = Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
    if (dragging === 'start') start = Math.min(t, end - 0.02); else end = Math.max(t, start + 0.02);
    draw();
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', () => { dragging = null; });

  // Preview of the trimmed part (stops when the dialog closes).
  let preview = null;
  const stopPreview = () => { try { preview?.stop(); } catch { /* ended */ } preview = null; playBtn.textContent = '▶ Preview'; };
  const playBtn = h('button.dbtn.small', { type: 'button', onclick: () => {
    if (preview) { stopPreview(); return; }
    const ctx = app.engine.ctx; app.engine.resume();
    preview = ctx.createBufferSource(); preview.buffer = buf;
    const gn = ctx.createGain(); gn.gain.value = Number(gain.value);
    preview.connect(gn); gn.connect(app.sampler.bus);
    preview.loop = mode.value === 'loop'; preview.loopStart = start; preview.loopEnd = end;
    preview.start(0, start, preview.loop ? undefined : end - start);
    preview.onended = () => stopPreview();
    playBtn.textContent = '■ Stop';
  } }, '▶ Preview');

  const body = h('div.sample-editor', {},
    h('div.form-grid', {},
      h('label', {}, 'Name'), name,
      h('label', {}, 'Trim'), h('div', {}, canvas, h('div.frow', {}, playBtn, times, h('button.dbtn.small', { type: 'button', onclick: () => { start = 0; end = dur; draw(); } }, 'Reset'))),
      h('label', {}, 'Play mode'), mode,
      h('label', {}, 'Sync to master tempo'), h('div', {}, sync),
      h('label', {}, 'Original BPM'), bpm,
      h('label', {}, 'Gain'), h('div.frow', {}, gain, gainVal)));
  requestAnimationFrame(draw);
  setTimeout(draw, 60);
  const ok = await modal(`Edit sample ${i + 1}`, body, [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, value: true }]);
  stopPreview();
  if (!ok) return false;
  const patch = { name: name.value.trim() || s.name, mode: mode.value, sync: sync.checked, bpm: Number(bpm.value) || 0, gain: Number(gain.value) };
  const trimmed = start > 0.001 || end < dur - 0.001;
  if (!trimmed) { sampler.update(i, patch); return true; }
  // New buffer with the trimmed part, saved as a new WAV in the samples folder.
  const sr = buf.sampleRate; const a = Math.round(start * sr); const b = Math.round(end * sr);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(a, b));
  const path = await app.writeSampleFile(patch.name, chans, sr);
  const out = new AudioBuffer({ numberOfChannels: chans.length, length: chans[0].length, sampleRate: sr });
  chans.forEach((c, k) => out.copyToChannel(c, k));
  sampler.setSlot(i, { ...patch, path, buffer: out });
  return true;
}
