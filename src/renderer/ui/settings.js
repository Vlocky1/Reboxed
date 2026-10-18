import { h, modal } from './dom.js';
import { BPM_RANGES } from '../analysis/analyzer.js';
import { SHORTCUT_HELP } from './keyboard.js';

/** Stem model status/download, processing device and cache. */
async function stemsSection(library, apply) {
  const status = await window.rb.stems.status();
  const s = library.settings;
  const modelRow = (quality, name, size) => {
    const ready = `Installed — ${name}, ${size}.`;
    const info = h('span.dim', {}, status.models?.[quality] ? ready : 'Not installed.');
    const bar = h('progress', { max: 1, value: 0, hidden: true });
    const dl = h('button.dbtn.small', { hidden: !!status.models?.[quality] }, `Download (${size})`);
    dl.onclick = async () => {
      dl.disabled = true; bar.hidden = false;
      const off = window.rb.stems.on('stems:download', (q, got, total) => {
        if (q !== quality) return;
        bar.value = got / total; info.textContent = `Downloading… ${Math.round((got / total) * 100)}%`;
      });
      try {
        await window.rb.stems.download(quality);
        info.textContent = ready; dl.hidden = true;
      } catch (err) {
        info.textContent = `Download failed: ${err.message}`; dl.disabled = false;
      } finally { off(); bar.hidden = true; }
    };
    return h('div', {}, info, ' ', dl, bar);
  };
  const sel = (key, options) => h('select', { onchange: (e) => apply(key, e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: s[key] === v }, l)));
  const clear = h('button.dbtn.small', { onclick: async () => { await window.rb.stems.removeAll(); clear.textContent = 'Cache cleared'; } }, 'Clear the hidden cache (stems beside your music stay)');
  return h('div.form-grid', {},
    h('label', {}, 'FAST model'), modelRow('fast', 'Spleeter 4-stem, Apache-2.0', '79 MB'),
    h('label', {}, 'HQ model'), modelRow('hq', 'HT-Demucs v4, MIT', '166 MB'),
    h('label', {}, 'Quality'), sel('stemsQuality', [
      ['auto', 'Auto — FAST instantly, upgrade to HQ in background'],
      ['fast', 'FAST only (~7× real time, starts at the playhead)'],
      ['hq', 'HQ only (~0.7× real time, best isolation)']]),
    h('label', {}, 'Separate on load'), h('input', { type: 'checkbox', checked: !!s.stemsOnLoad, onchange: (e) => apply('stemsOnLoad', e.target.checked) }),
    h('label', {}, 'Stem waveform'), sel('stemWaveform', [
      ['muted', 'Colour by stem, dim muted stems'], ['always', 'Always colour by stem'], ['off', 'Classic waveform']]),
    h('label', {}, 'Keep stems'), sel('stemsLocation', [
      ['beside', 'Beside the music: <folder>/stems/<track>/*.wav'], ['appdata', 'In the Reboxed cache (hidden)']]),
    h('label', {}, 'Processing'), sel('stemsProvider', [
      ['cpu', 'CPU (recommended)'], ['dml', 'DirectML GPU (experimental, falls back to CPU)']]),
    h('label', {}, 'Cache'), clear);
}

/** Preferences dialog. Applies changes through `apply(key, value)`. */
export async function openSettings(library, engine, apply, midi) {
  const s = library.settings;
  const devices = await engine.outputDevices().catch(() => []);
  const sel = (key, options, cast = (v) => v) => h('select', { onchange: (e) => apply(key, cast(e.target.value)) },
    options.map(([v, label]) => h('option', { value: v, selected: String(s[key]) === String(v) }, label)));
  const check = (key) => h('input', { type: 'checkbox', checked: s[key], onchange: (e) => apply(key, e.target.checked) });
  const deviceOptions = [['', 'System default'], ...devices.filter((d) => d.deviceId !== 'default').map((d) => [d.deviceId, d.label || d.deviceId])];

  const body = h('div.settings', {},
    h('h3', {}, 'Analysis'),
    h('div.form-grid', {},
      h('label', {}, 'Analyze on import'), check('autoAnalyze'),
      h('label', {}, 'BPM range'), h('select', { onchange: (e) => apply('bpmRange', e.target.value.split('-').map(Number)) },
        BPM_RANGES.map(([a, b]) => h('option', { value: `${a}-${b}`, selected: s.bpmRange[0] === a && s.bpmRange[1] === b }, `${a} - ${b}`))),
      h('label', {}, 'Beatgrid mode'), sel('analysisMode', [['normal', 'Normal (constant tempo)'], ['dynamic', 'Dynamic (variable tempo)']]),
      h('label', {}, 'Key notation'), sel('keyNotation', [['camelot', 'Alphanumeric (8A)'], ['musical', 'Classic (Am)']]),
      h('label', {}, 'Create cues from phrases'), check('autoCues')),
    h('h3', {}, 'View'),
    h('div.form-grid', {},
      h('label', {}, 'Waveform color'), sel('waveformColor', [['3band', '3Band'], ['rgb', 'RGB'], ['blue', 'BLUE']])),
    h('h3', {}, 'Deck & Mixer'),
    h('div.form-grid', {},
      h('label', {}, 'Decks'), sel('deckCount', [[2, '2 decks'], [4, '4 decks']], Number),
      h('label', {}, 'Sync mode'), sel('syncMode', [['beat', 'BEAT SYNC (tempo + phase)'], ['bpm', 'BPM SYNC (tempo only)']]),
      h('label', {}, 'Sync double/half BPM'), check('syncDoubleHalf'),
      h('label', {}, 'Default tempo range'), sel('defaultTempoRange', [[6, '±6%'], [10, '±10%'], [16, '±16%'], [100, 'WIDE']], Number),
      h('label', {}, 'Auto gain'), check('autoGain'),
      h('label', {}, 'Channel fader curve'), sel('faderCurve', [['linear', 'Linear'], ['exp', 'Exponential'], ['log', 'Logarithmic']]),
      h('label', {}, 'Crossfader curve'), sel('crossfaderCurve', [['smooth', 'Smooth'], ['constant', 'Constant power'], ['cut', 'Sharp cut']])),
    h('h3', {}, 'Audio output'),
    h('div.form-grid', {},
      h('label', {}, 'Master out'), sel('masterDevice', deviceOptions),
      h('label', {}, 'Headphones (cue)'), sel('phonesDevice', [['', 'Off'], ...deviceOptions.slice(1)]),
      h('label', {}, 'Output channels'), sel('outputLayout', [['stereo', 'Stereo (headphones on a 2nd device)'], ['quad', '4 channels: master 1/2, headphones 3/4 (DJ controller)']]),
      h('label', {}, 'Use controller sound card automatically'), check('controllerAudioAuto')),
    h('h3', {}, 'Stems'),
    await stemsSection(library, apply),
    h('h3', {}, 'MIDI'),
    midi ? midi.renderSettings() : h('p.dim', {}, 'MIDI not initialised'),
    h('h3', {}, 'Keyboard'),
    h('table.shortcuts', {}, h('tr', {}, h('th', {}, 'Function'), h('th', {}, 'Deck 1'), h('th', {}, 'Deck 2')),
      SHORTCUT_HELP.map(([f, a, b]) => h('tr', {}, h('td', {}, f), h('td', {}, a), h('td', {}, b)))));
  await modal('Preferences', body, [{ label: 'Close', primary: true, value: true }]);
}
