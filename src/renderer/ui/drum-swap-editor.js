// DRUM SWAP slots of one deck: what each of the 8 slots (banks A and B) plays: a built-in loop,
// an audio file, the track's drums (capture), or nothing; its gain; play / eject / reset.
import { h, modal, toast } from './dom.js';
import { DRUM_PATTERNS } from '../../shared/drumkit.js';
import { CAPTURE_LENGTHS } from '../audio/groove.js';

/** Bars of a loop file at `bpm` (whole bars, at least 1). */
export const loopBars = (seconds, bpm) => Math.max(1, Math.round((seconds * bpm) / 240));

/**
 * @param {object} app Reboxed App
 * @param {number} i deck index
 */
export function openDrumSwapEditor(app, i) {
  const g = app.groove[i];
  const body = h('div.dse');
  const grid = h('div.dse-grid');
  const saved = (bank, slot) => app.saveGrooveSlot(i, bank, slot);

  /** Play / stop a slot of any bank (the deck plays the loop in time). */
  const play = (bank, slot) => {
    if (!app.engine.decks[i].playing) { toast('Play the deck to hear the DRUM SWAP loops in time'); return; }
    g.setBank(bank);
    g.toggle(slot);
  };

  const loadFile = async (bank, slot) => {
    const [path] = await window.rb.openFiles('audio');
    if (!path) return;
    try {
      const buffer = await app.analyzer.decode(path);
      // Tempo of the loop: from its own beat analysis, else the deck's.
      let bpm = 0;
      try { bpm = (await app.analyzer.analyzeBuffer(buffer)).beatgrid?.bpm ?? 0; } catch { /* too short to analyse */ }
      if (!bpm) bpm = app.engine.decks[i].originalBpm || 120;
      const name = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      g.store(bank, slot, { buffer, bpm, bars: loopBars(buffer.duration, bpm), name, file: path });
      saved(bank, slot);
    } catch (err) { toast(`Cannot load this file: ${err.message}`, 5000); }
  };

  const capture = async (bank, slot) => {
    g.setBank(bank);
    if ((await app.drumCapture(i, slot)) >= 0) saved(bank, slot);
  };

  const card = (bank, slot) => {
    const s = g.slots[bank][slot];
    const source = h('select.dse-source', {
      title: 'What this slot plays',
      onchange: (e) => {
        const v = e.target.value;
        if (v === 'file') loadFile(bank, slot);
        else if (v === 'capture') capture(bank, slot);
        else if (v === 'empty') { g.eject(bank, slot); saved(bank, slot); }
        else if (v.startsWith('builtin:')) { g.setBuiltin(bank, slot, Number(v.slice(8))); saved(bank, slot); }
        render();
      },
    },
    h('optgroup', { label: 'Built-in loops' }, DRUM_PATTERNS.map((p, k) => h('option', { value: `builtin:${k}`, selected: s?.builtin === k }, `${p.name} (${p.bars} bar${p.bars > 1 ? 's' : ''})`))),
    s && s.builtin === undefined ? h('option', { value: 'current', selected: true }, `${s.file ? 'File' : 'Captured'}: ${s.name}`) : null,
    h('option', { value: 'file' }, 'Audio file…'),
    h('option', { value: 'capture' }, 'Capture the track\'s drums here'),
    h('option', { value: 'empty', selected: !s }, '(empty)'));
    const gainVal = h('span.dse-gain-val', {}, `${Math.round((s?.gain ?? 1) * 100)}%`);
    const gain = h('input.fader.dse-gain', {
      type: 'range', min: 0, max: 2, step: 0.05, value: s?.gain ?? 1, disabled: !s,
      oninput: (e) => { g.setSlotGain(bank, slot, Number(e.target.value)); gainVal.textContent = `${Math.round(Number(e.target.value) * 100)}%`; },
      onchange: () => saved(bank, slot),
    });
    const playing = g.playing.has(g.key(slot, bank));
    return h(`div.dse-card${playing ? '.playing' : ''}${!s ? '.empty' : ''}`, {},
      h('div.dse-head', {}, h('b', {}, `${'AB'[bank]}${slot + 1}`), h('span.dse-name', {}, s?.name ?? '(empty)')),
      source,
      h('div.dse-row', {}, h('span.dim', {}, 'GAIN'), gain, gainVal),
      h('div.dse-row', {},
        h('button.dbtn.small', { type: 'button', disabled: !s, onclick: () => { play(bank, slot); render(); } }, playing ? '■ Stop' : '▶ Play'),
        h('button.dbtn.small', { type: 'button', disabled: !s, title: 'Empty this slot', onclick: () => { g.eject(bank, slot); saved(bank, slot); render(); } }, '⏏ Eject'),
        h('button.dbtn.small', { type: 'button', title: 'Back to this slot\'s built-in loop', onclick: () => { g.reset(bank, slot); saved(bank, slot); render(); } }, 'Reset')));
  };

  const length = h('select', { title: 'DRUM CAPTURE length', onchange: (e) => { g.captureBars = Number(e.target.value); g.emit(); } },
    CAPTURE_LENGTHS.map((b) => h('option', { value: b, selected: g.captureBars === b }, `${b * 4} beats`)));
  const render = () => grid.replaceChildren(...[0, 1].map((bank) => h('div.dse-bank', {},
    h('h4', {}, `BANK ${'AB'[bank]}`), h('div.dse-cards', {}, [0, 1, 2, 3].map((slot) => card(bank, slot))))));
  const onChange = () => { if (!grid.contains(document.activeElement)) render(); };
  g.addEventListener('change', onChange);
  render();
  body.append(
    h('p.dim', {}, 'Each slot replaces the track\'s drums when it plays, in time with the deck. Pick a built-in loop, an audio file (a drum loop), or capture the drums of the track playing.'),
    grid,
    h('div.dse-row', {}, h('span.dim', {}, 'DRUM CAPTURE length'), length));
  return modal(`DRUM SWAP — Deck ${i + 1}`, body, [{ label: 'Close', value: true, primary: true }])
    .finally(() => g.removeEventListener('change', onChange));
}
