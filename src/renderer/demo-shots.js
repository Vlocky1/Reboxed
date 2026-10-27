// npm run shots: screenshots of the real Reboxed, feature by feature, for the website and the
// README. It runs in a throw-away app folder (like the smoke test) on a demo library: tracks are
// synthesised here (intro / build / drop / break structure, real tempos and keys), artists are
// fictional, covers are drawn. Network shots (Deezer) use the real services.
import { encodeWav } from '../shared/wav.js';
import { applyTheme } from './themes.js';
import { openAutoTag } from './ui/autotag.js';
import { openCleanNames } from './ui/clean-names.js';
import { openCdjExport } from './ui/cdj-export.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SR = 44100;

/** A small deterministic random generator (same demo every run). */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

/**
 * A demo dance track: 8 bars intro, 8 build, 24 drop, 16 break, 24 drop, 12 outro.
 * @returns {Float32Array[]} stereo
 */
export function demoTrack({ bpm, root, minor = true, seed = 1, bars = [8, 8, 24, 16, 24, 12] }) {
  const rand = rng(seed);
  const beat = 60 / bpm; const bar = beat * 4;
  const total = bars.reduce((a, b) => a + b, 0);
  const n = Math.ceil((total * bar + 1) * SR);
  const L = new Float32Array(n); const R = new Float32Array(n);
  const sect = (b) => { let acc = 0; for (const [i, len] of bars.entries()) { if (b < acc + len) return ['intro', 'build', 'drop', 'break', 'drop2', 'outro'][i]; acc += len; } return 'outro'; };
  const add = (t, len, fn, gl = 1, gr = 1) => {
    const s0 = Math.round(t * SR);
    for (let j = 0; j < len * SR && s0 + j < n; j++) { const v = fn(j / SR); L[s0 + j] += v * gl; R[s0 + j] += v * gr; }
  };
  // Chords: minor i - VI - III - VII, major I - V - vi - IV (two bars each).
  const prog = minor ? [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]] : [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]];
  for (let b = 0; b < total; b++) {
    const t0 = b * bar; const s = sect(b);
    const chord = prog[Math.floor(b / 2) % 4].map((x) => x + root);
    const drums = s !== 'break';
    const full = s === 'drop' || s === 'drop2';
    for (let q = 0; q < 4; q++) {
      const t = t0 + q * beat;
      if (drums && !(s === 'outro' && b >= total - 2)) add(t, 0.32, (x) => 0.95 * Math.exp(-x / 0.09) * Math.sin(2 * Math.PI * (48 * x + 110 * 0.03 * (1 - Math.exp(-x / 0.03)))));
      if ((full || s === 'build') && q % 2 === 1) add(t, 0.18, (x) => 0.32 * Math.exp(-x / 0.05) * (rand() * 2 - 1));
      if (s !== 'intro' && drums) add(t + beat / 2, 0.06, (x) => 0.16 * Math.exp(-x / 0.012) * (rand() * 2 - 1), 0.8, 1);
      if (full) add(t + beat / 2, 0.22, (x) => { const f = midiHz(chord[0] + 24 - 12); return 0.3 * Math.exp(-x / 0.12) * [1, 2, 3, 4, 5].reduce((a, h) => a + Math.sin(2 * Math.PI * f * h * x) / h, 0); });
    }
    // Pads in the build, the drops and the break; arpeggio over the break and the second drop.
    if (s !== 'intro' && s !== 'outro') {
      const amp = s === 'break' ? 0.16 : 0.08;
      chord.forEach((m, k) => add(t0, bar, (x) => amp * Math.sin(Math.PI * Math.min(1, x / (bar * 0.5))) * Math.sin(2 * Math.PI * midiHz(m + 12) * x + k), k === 1 ? 1.15 : 0.85, k === 1 ? 0.85 : 1.15));
    }
    if (s === 'break' || s === 'drop2') {
      for (let k = 0; k < 16; k++) {
        const m = chord[k % 3] + 24 + (k % 6 === 5 ? 12 : 0);
        add(t0 + k * beat / 4, beat / 4, (x) => 0.1 * Math.exp(-x / 0.08) * (Math.sin(2 * Math.PI * midiHz(m) * x) + 0.3 * Math.sin(4 * Math.PI * midiHz(m) * x)), k % 2 ? 0.7 : 1.2, k % 2 ? 1.2 : 0.7);
      }
    }
    if (s === 'build' && b >= bars[0] + bars[1] - 4) add(t0, bar, (x) => 0.05 * ((b - (bars[0] + bars[1] - 4)) * bar + x) / (4 * bar) * (rand() * 2 - 1));
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  for (let i = 0; i < n; i++) { L[i] *= 0.9 / peak; R[i] *= 0.9 / peak; }
  return [L, R];
}

/** A cover: gradient, rings and the title, drawn on a canvas. */
async function cover(title, hueA, hueB) {
  const c = document.createElement('canvas'); c.width = 300; c.height = 300;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 300, 300);
  grad.addColorStop(0, `hsl(${hueA} 70% 45%)`); grad.addColorStop(1, `hsl(${hueB} 75% 18%)`);
  g.fillStyle = grad; g.fillRect(0, 0, 300, 300);
  for (let i = 0; i < 6; i++) { g.strokeStyle = `hsla(${hueA + i * 12} 90% 70% / ${0.25 - i * 0.03})`; g.lineWidth = 10 - i; g.beginPath(); g.arc(210, 90, 30 + i * 26, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = 'rgba(255,255,255,.92)'; g.font = 'bold 26px Segoe UI'; g.fillText(title.toUpperCase().slice(0, 16), 18, 270);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  return new Uint8Array(await blob.arrayBuffer());
}

const DEMO = [
  { artist: 'Nova Drift', title: 'Afterglow (Extended Mix)', album: 'Afterglow EP', genre: 'Deep House', bpm: 124, root: 57, minor: true, label: 'Lumen Audio', hue: [200, 260], color: 'Blue', rating: 5 },
  { artist: 'Kaia Moreno', title: 'Paper Satellites (Original Mix)', album: 'Paper Satellites', genre: 'Melodic Techno', bpm: 126, root: 53, minor: true, label: 'Northline', hue: [280, 330], color: 'Purple', rating: 4 },
  { artist: 'Static Bloom', title: 'Midnight Lanes', album: 'City Lights', genre: 'House', bpm: 122, root: 50, minor: true, label: 'Lumen Audio', hue: [20, 350], color: 'Orange', rating: 4 },
  { artist: 'Orbit Theory', title: 'Glasshouse (Club Mix)', album: 'Glasshouse', genre: 'Tech House', bpm: 128, root: 55, minor: true, label: 'Parallax', hue: [160, 210], color: 'Green', rating: 3 },
  { artist: 'Lune Rouge', title: 'Les Nuits Claires', album: 'Nuits', genre: 'Nu Disco', bpm: 120, root: 60, minor: false, label: 'Maison Lune', hue: [340, 20], color: 'Pink', rating: 5 },
  { artist: 'Halcyon Grid', title: 'Overdrive', album: 'Overdrive', genre: 'Techno', bpm: 132, root: 52, minor: true, label: 'Parallax', hue: [0, 40], color: 'Red', rating: 4 },
  { artist: 'Mira Vale & Teo', title: 'Coastline', album: 'Coastline', genre: 'Progressive House', bpm: 123, root: 58, minor: true, label: 'Northline', hue: [180, 230], color: 'Aqua', rating: 3 },
  { artist: 'Kaia Moreno', title: 'Low Orbit', album: 'Paper Satellites', genre: 'Melodic Techno', bpm: 125, root: 54, minor: true, label: 'Northline', hue: [250, 300], color: '', rating: 4 },
];

export async function runShots(app) {
  const report = { ok: true, steps: [] };
  const lib = app.library;
  const shot = async (name) => { await wait(350); await window.rb.smokeShot(name); report.steps.push({ name, ok: true, info: 'shot' }); };
  const attempt = async (name, fn) => {
    try { await fn(); } catch (err) { report.steps.push({ name, ok: false, info: String(err?.stack ?? err) }); console.error(name, err); }
  };
  const closeDialog = () => document.querySelectorAll('.overlay').forEach((o) => o.querySelector('.dialog-buttons button')?.click());
  try {
    await app.engine.ctx.resume();
    const dir = await window.rb.smokeDir();
    lib.setSetting('waveformColor', 'rgb');
    // ---- demo library ----
    for (const [i, d] of DEMO.entries()) {
      const [L, R] = demoTrack({ bpm: d.bpm, root: d.root, minor: d.minor, seed: i + 7 });
      await window.rb.writeFile(`${dir}\\music\\${d.artist} - ${d.title}.wav`, encodeWav([L, R], SR));
    }
    await app.importPaths([`${dir}\\music`]);
    while (app.analyzing || app.queue.length) await wait(150);
    const ids = [];
    for (const [i, d] of DEMO.entries()) {
      const t = lib.all().find((x) => x.path.includes(`${d.artist} - ${d.title}`));
      const art = `${dir}\\artwork\\demo-${i}.jpg`; // the library artwork folder (served to the UI)
      await window.rb.writeFile(art, await cover(d.title.replace(/ \(.*/, ''), ...d.hue));
      lib.update(t.id, { artist: d.artist, title: d.title, album: d.album, genre: d.genre, label: d.label, year: 2026, color: d.color, rating: d.rating, artwork: art, comments: '' });
      ids.push(t.id);
      await app.createCuesFor(t.id);
    }
    const folder = lib.createNode('folder', 'Saturday set');
    const warm = lib.createNode('playlist', 'Warm-up', folder.id); lib.addToPlaylist(warm.id, [ids[4], ids[2], ids[6], ids[0]]);
    const peak = lib.createNode('playlist', 'Peak time', folder.id); lib.addToPlaylist(peak.id, [ids[1], ids[3], ids[7], ids[5]]);
    lib.createNode('playlist', 'Downloads');
    app.browser.select('collection');

    // ---- performance view: two decks playing, in sync ----
    const [d1, d2, d3, d4] = app.engine.decks;
    lib.setSetting('deckCount', 2); app.applyLayout();
    await app.loadTrack(0, ids[0]); await app.loadTrack(1, ids[1]);
    d1.seek(d1.bg ? d1.bg.timeOf(16 * 4 + 8) : 40); d2.seek(d2.bg ? d2.bg.timeOf(16 * 4) : 40);
    d1.play(); d2.play(); if (!d2.sync) d2.toggleSync();
    app.engine.setCrossfader?.(-0.2);
    await wait(1500);
    await attempt('performance', () => shot('01-performance'));

    // ---- stems (FAST model) ----
    await attempt('stems', async () => {
      if (!(await window.rb.stems.status()).models.fast) throw new Error('no FAST model (REBOXED_SPLEETER_DIR)');
      lib.setSetting('stemsQuality', 'fast');
      await app.separateStems(ids[0], { quality: 'fast', deck: d1 });
      for (let i = 0; i < 600 && !d1.stemsComplete; i++) await wait(100);
      lib.setSetting('stemWaveform', 'always');
      d1.setStemOn(3, false);
      await wait(800);
      await shot('02-stems');
      d1.setStemOn(3, true);
      lib.setSetting('stemWaveform', 'muted');
    });

    // ---- precise zoomed waveform ----
    await attempt('zoom', async () => { app.zoom = 1.5; await shot('03-waveform-zoom'); app.zoom = 8; });

    // ---- four decks ----
    await attempt('four decks', async () => {
      lib.setSetting('deckCount', 4); app.applyLayout();
      await app.loadTrack(2, ids[3]); await app.loadTrack(3, ids[5]);
      d3.seek(60); d4.seek(30); d3.play(); if (!d3.sync) d3.toggleSync();
      await wait(1200);
      await shot('04-four-decks');
      d3.pause(); d4.pause();
      lib.setSetting('deckCount', 2); app.applyLayout();
    });

    // ---- sampler and library view ----
    await attempt('sampler', async () => { app.toggleSampler(); await wait(300); await shot('05-sampler'); app.toggleSampler(); });
    // ---- PADS: the EDM kit with a pad open in the editor and light effects running ----
    await attempt('pads', async () => {
      app.togglePads(true);
      app.pads.selectKit(1);
      app.padSurface.setMode('sampler');
      app.padView.select(19, true); // a PLUCK pad in the editor
      for (const [x, y] of [[0, 7], [3, 4], [6, 2]]) { app.padSurface.press(x, y, 110); setTimeout(() => app.padSurface.press(x, y, 0), 200); await wait(120); }
      await wait(150);
      await shot('24-pads');
      app.padSurface.selected = null;
      app.togglePads(false);
    });
    // ---- track suggestion after the master deck ----
    await attempt('suggest', async () => {
      app.browser.select('suggest');
      await wait(300);
      await shot('25-suggest');
      app.browser.select('collection');
    });
    await attempt('library', async () => {
      app.modeSel.value = 'library'; app.modeSel.dispatchEvent(new Event('change'));
      app.browser.select(peak.id);
      await shot('06-library');
      app.modeSel.value = 'performance'; app.modeSel.dispatchEvent(new Event('change'));
      app.browser.select('collection');
    });
    d1.pause(); d2.pause();

    // ---- downloads: platform choice and link detection ----
    await attempt('downloads', async () => {
      app.downloads.save({ platform: 'soundcloud' });
      app.downloads.open('search');
      await wait(200);
      const input = document.querySelector('.dlc-bar input.text'); input.value = 'nova drift afterglow';
      await shot('07-download-search');
      app.downloads.showTab('link');
      await wait(100);
      const link = document.querySelector('.dlc-bar input.text');
      link.value = 'https://soundcloud.com/artist/track-name'; link.dispatchEvent(new Event('input'));
      await shot('08-download-link');
      document.querySelector('.dlc-x')?.click();
      app.downloads.save({ platform: 'youtube' });
    });

    // ---- name cleaner on video-style names ----
    const messy = [
      ['Daft Punk - One More Time (Official Video) [HD]', ''],
      ['Nova Drift - Afterglow (Lyrics) | Visualizer', 'NovaDriftVEVO'],
      ['Coastline (Clip officiel) [Paroles]', 'Mira Vale & Teo - Topic'],
    ];
    const messyIds = [ids[4], ids[0], ids[6]];
    const before = messyIds.map((id) => ({ id, title: lib.get(id).title, artist: lib.get(id).artist }));
    messyIds.forEach((id, i) => lib.update(id, { title: messy[i][0], artist: messy[i][1] }));
    await attempt('clean names', async () => {
      const done = openCleanNames(app, messyIds);
      await wait(300);
      await shot('09-clean-names');
      document.querySelector('.autotag-dialog .dialog-buttons button')?.click();
      await done;
    });

    // ---- auto-tag with a real Deezer lookup ----
    await attempt('auto-tag', async () => {
      lib.setSetting('autoTagRecipe', { tolerance: 9999, steps: [{ source: 'deezer', fields: ['title', 'artist', 'album', 'genre', 'year'], titleWithMix: true }] });
      const done = openAutoTag(app, [messyIds[0]]);
      await wait(300);
      await shot('10-autotag-recipe');
      document.querySelector('.autotag-dialog .dialog-buttons .primary').click();
      for (let i = 0; i < 200 && !document.querySelector('.at-change, .at-miss'); i++) await wait(100);
      await shot('11-autotag-review');
      document.querySelector('.autotag-dialog .dialog-buttons button:nth-child(2)')?.click();
      await done;
    });
    before.forEach((b) => lib.update(b.id, { title: b.title, artist: b.artist }));

    // ---- Track information with a real Deezer search ----
    await attempt('track info', async () => {
      const done = app.browser.editTrack(ids[0]);
      await wait(300);
      try { localStorage.setItem('reboxed.lookupSource', 'deezer'); } catch { /* */ }
      document.querySelector('.ti-sp-open').click();
      await wait(100);
      const q = document.querySelector('.ti-spotify .dlc-bar input.text'); q.value = 'Daft Punk One More Time';
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      for (let i = 0; i < 150 && !/Daft Punk/.test(document.querySelector('.ti-sp-status select, .ti-sp-head')?.parentElement?.textContent ?? ''); i++) await wait(100);
      await shot('12-track-info-lookup');
      document.querySelectorAll('.dialog:has(.trackinfo) .dialog-buttons button')[1]?.click();
      await done;
    });

    // ---- preferences: appearance, themes, plugins, library, stems ----
    const prefs = async (tab, name, extra) => {
      const done = app.openSettings(tab);
      await wait(400);
      if (extra) await extra();
      await shot(name);
      document.querySelector('.settings-close').click();
      await done;
    };
    await attempt('appearance', () => prefs('appearance', '13-appearance'));
    for (const [theme, name] of [['midnight', '14-theme-midnight'], ['neon', '15-theme-neon'], ['ember', '16-theme-ember']]) {
      await attempt(name, async () => { lib.setSetting('theme', theme); applyTheme(lib.settings); d1.play(); d2.play(); await wait(800); await shot(name); d1.pause(); d2.pause(); });
    }
    lib.setSetting('theme', 'dark'); applyTheme(lib.settings);
    await attempt('plugins', () => prefs('plugins', '17-plugins'));
    await attempt('library settings', () => prefs('library', '18-library-settings'));
    await attempt('stems settings', () => prefs('stems', '19-stems-settings'));
    await attempt('downloads settings', () => prefs('downloads', '20-downloads-settings'));

    // ---- a real song (free licence, path in REBOXED_DEMO_SONG): HQ stems, exported for the website ----
    await attempt('demo song stems', async () => {
      const song = await window.rb.smokeDemoSong();
      if (!song) { report.steps.push({ name: 'demo song (skipped: no REBOXED_DEMO_SONG)', ok: true, info: '' }); return; }
      await app.importPaths([song.path]);
      while (app.analyzing || app.queue.length) await wait(150);
      const t = lib.all().find((x) => x.path === song.path);
      lib.update(t.id, { title: song.title, artist: song.artist, genre: 'Electronic' });
      await app.createCuesFor(t.id);
      lib.setSetting('deckCount', 2); app.applyLayout();
      await app.loadTrack(0, t.id);
      if (!(await window.rb.stems.status()).models.hq) throw new Error('no HQ model (REBOXED_STEM_MODEL)');
      lib.setSetting('stemsQuality', 'hq');
      await app.separateStems(t.id, { quality: 'hq', deck: d1 });
      for (let i = 0; i < 3000 && !(d1.stemsComplete && d1.stemQuality === 'hq'); i++) await wait(200);
      const meta = await window.rb.stems.meta(t.id, t.path);
      const shotFile = await window.rb.smokeShot('22-song-loaded');
      const outDir = shotFile.replace(/[\\/][^\\/]+$/, '') + '\\stems';
      for (const s of meta.stems) await window.rb.copyInto(`${meta.dir}\\${s}.${meta.format === 'mp3' ? 'mp3' : 'wav'}`, outDir);
      await window.rb.writeFile(`${outDir}\\stems.json`, new TextEncoder().encode(JSON.stringify({
        title: song.title, artist: song.artist, bpm: t.bpm, key: t.key, duration: t.duration, rate: meta.rate, frames: meta.frames, mp3Delay: meta.mp3Delay ?? 0,
        stems: meta.stems, vocals: meta.vocals, phrases: (await window.rb.getAnalysis(t.id))?.phrases?.phrases ?? [],
      })));
      // Stem-coloured waveform, vocals muted, on the drop.
      lib.setSetting('stemWaveform', 'always');
      const vocal = (meta.vocals ?? [])[1] ?? (meta.vocals ?? [])[0];
      d1.seek(vocal ? vocal[0] + 2 : t.duration * 0.4);
      d1.play();
      d1.setStemOn(3, false);
      await wait(1500);
      await shot('23-song-stems');
      d1.setStemOn(3, true);
      d1.pause();
      lib.setSetting('stemWaveform', 'muted');
    });

    // ---- CDJ export ----
    await attempt('cdj export', async () => {
      const done = openCdjExport(app);
      await wait(500);
      await shot('21-cdj-export');
      closeDialog();
      await done;
    });
  } catch (err) {
    report.ok = false;
    report.error = String(err?.stack ?? err);
  }
  report.ok = report.ok && report.steps.every((s) => s.ok);
  window.rb.smokeReady(report);
}
