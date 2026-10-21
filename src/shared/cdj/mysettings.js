// Writer for the player / mixer preference files rekordbox puts at the root of an export drive:
// PIONEER/MYSETTING.DAT, MYSETTING2.DAT, DJMMYSETTING.DAT and DEVSETTING.DAT ("My Settings").
// Layout: u32 0x60, three 32-byte ASCII strings (brand, software, version), u32 data length, data,
// u16 CRC16-XMODEM, u16 0. The CRC covers the data (and, for DJMMYSETTING, everything before it).
// Values follow rekordcrate / pyrekordbox and a rekordbox 7 export; option names match rekordbox's
// own labels (MY SETTINGS in rekordbox Preferences).

/** Every option with its choices, in the player's display order. value = byte written. */
export const PLAYER_SETTINGS = {
  // MYSETTING.DAT
  onAirDisplay: { label: 'On air display', file: 'my', offset: 8, choices: { off: 0x80, on: 0x81 }, default: 'on' },
  lcdBrightness: { label: 'LCD brightness', file: 'my', offset: 9, choices: { 1: 0x81, 2: 0x82, 3: 0x83, 4: 0x84, 5: 0x85 }, default: '3' },
  quantize: { label: 'Quantize', file: 'my', offset: 10, choices: { off: 0x80, on: 0x81 }, default: 'on' },
  autoCueLevel: { label: 'Auto cue level', file: 'my', offset: 11, choices: { '-36 dB': 0x80, '-42 dB': 0x81, '-48 dB': 0x82, '-54 dB': 0x83, '-60 dB': 0x84, '-66 dB': 0x85, '-72 dB': 0x86, '-78 dB': 0x87, memory: 0x88 }, default: 'memory' },
  language: { label: 'Language', file: 'my', offset: 12, choices: { English: 0x81, French: 0x82, German: 0x83, Italian: 0x84, Dutch: 0x85, Spanish: 0x86, Russian: 0x87, Korean: 0x88, 'Chinese (simplified)': 0x89, 'Chinese (traditional)': 0x8a, Japanese: 0x8b, Portuguese: 0x8c, Swedish: 0x8d, Czech: 0x8e, Hungarian: 0x8f, Danish: 0x90, Greek: 0x91, Turkish: 0x92 }, default: 'English' },
  jogRingBrightness: { label: 'Jog ring brightness', file: 'my', offset: 14, choices: { off: 0x80, dark: 0x81, bright: 0x82 }, default: 'bright' },
  jogRingIndicator: { label: 'Jog ring indicator', file: 'my', offset: 15, choices: { off: 0x80, on: 0x81 }, default: 'on' },
  slipFlashing: { label: 'Slip flashing', file: 'my', offset: 16, choices: { off: 0x80, on: 0x81 }, default: 'on' },
  discSlotIllumination: { label: 'Disc slot illumination', file: 'my', offset: 20, choices: { off: 0x80, dark: 0x81, bright: 0x82 }, default: 'bright' },
  ejectLock: { label: 'Eject / load lock', file: 'my', offset: 21, choices: { unlock: 0x80, lock: 0x81 }, default: 'unlock' },
  sync: { label: 'Sync', file: 'my', offset: 22, choices: { off: 0x80, on: 0x81 }, default: 'off' },
  playMode: { label: 'Play mode', file: 'my', offset: 23, choices: { continue: 0x80, single: 0x81 }, default: 'single' },
  quantizeBeatValue: { label: 'Quantize beat value', file: 'my', offset: 24, choices: { '1': 0x80, '1/2': 0x81, '1/4': 0x82, '1/8': 0x83 }, default: '1' },
  hotCueAutoload: { label: 'Hot cue auto load', file: 'my', offset: 25, choices: { off: 0x80, on: 0x81, 'per-track setting': 0x82 }, default: 'on' },
  hotCueColor: { label: 'Hot cue color', file: 'my', offset: 26, choices: { off: 0x80, on: 0x81 }, default: 'on' },
  needleLock: { label: 'Needle lock', file: 'my', offset: 29, choices: { unlock: 0x80, lock: 0x81 }, default: 'lock' },
  timeMode: { label: 'Time mode', file: 'my', offset: 32, choices: { elapsed: 0x80, remain: 0x81 }, default: 'remain' },
  jogMode: { label: 'Jog mode', file: 'my', offset: 33, choices: { 'pitch bend': 0x80, vinyl: 0x81 }, default: 'vinyl' },
  autoCue: { label: 'Auto cue', file: 'my', offset: 34, choices: { off: 0x80, on: 0x81 }, default: 'on' },
  masterTempo: { label: 'Master tempo', file: 'my', offset: 35, choices: { off: 0x80, on: 0x81 }, default: 'off' },
  tempoRange: { label: 'Tempo range', file: 'my', offset: 36, choices: { '±6%': 0x80, '±10%': 0x81, '±16%': 0x82, wide: 0x83 }, default: '±10%' },
  phaseMeter: { label: 'Phase meter', file: 'my', offset: 37, choices: { 'type 1': 0x80, 'type 2': 0x81 }, default: 'type 1' },
  // MYSETTING2.DAT
  vinylSpeedAdjust: { label: 'Vinyl speed adjust', file: 'my2', offset: 0, choices: { 'touch & release': 0x80, touch: 0x81, release: 0x82 }, default: 'touch' },
  jogDisplayMode: { label: 'Jog display mode', file: 'my2', offset: 1, choices: { auto: 0x80, info: 0x81, simple: 0x82, artwork: 0x83 }, default: 'auto' },
  padButtonBrightness: { label: 'Pad / button brightness', file: 'my2', offset: 2, choices: { 1: 0x81, 2: 0x82, 3: 0x83, 4: 0x84 }, default: '3' },
  jogLcdBrightness: { label: 'Jog LCD brightness', file: 'my2', offset: 3, choices: { 1: 0x81, 2: 0x82, 3: 0x83, 4: 0x84, 5: 0x85 }, default: '3' },
  waveformDivisions: { label: 'Waveform divisions', file: 'my2', offset: 4, choices: { 'time scale': 0x80, phrase: 0x81 }, default: 'phrase' },
  waveformOrPhaseMeter: { label: 'Waveform / phase meter', file: 'my2', offset: 10, choices: { waveform: 0x80, 'phase meter': 0x81 }, default: 'waveform' },
  beatJumpBeatValue: { label: 'Beat jump beat value', file: 'my2', offset: 12, choices: { '1/2': 0x80, '1': 0x81, '2': 0x82, '4': 0x83, '8': 0x84, '16': 0x85, '32': 0x86, '64': 0x87 }, default: '16' },
  // DEVSETTING.DAT (rekordbox: "Waveform color displayed on CDJ/XDJ" etc.)
  overviewWaveform: { label: 'Overview waveform', file: 'dev', offset: 9, choices: { 'half waveform': 1, 'full waveform': 2 }, default: 'half waveform' },
  waveformColor: { label: 'Waveform color', file: 'dev', offset: 10, choices: { BLUE: 1, RGB: 3, '3Band': 4 }, default: 'RGB' },
  keyDisplayFormat: { label: 'Key display format', file: 'dev', offset: 12, choices: { classic: 1, alphanumeric: 2 }, default: 'classic' },
  waveformCurrentPosition: { label: 'Waveform current position', file: 'dev', offset: 13, choices: { center: 1, left: 2 }, default: 'center' },
};

/** Mixer (DJM) options. */
export const MIXER_SETTINGS = {
  channelFaderCurve: { label: 'Channel fader curve', file: 'djm', offset: 12, choices: { 'steep top': 0x80, linear: 0x81, 'steep bottom': 0x82 }, default: 'linear' },
  crossFaderCurve: { label: 'Crossfader curve', file: 'djm', offset: 13, choices: { constant: 0x80, 'slow cut': 0x81, 'fast cut': 0x82 }, default: 'fast cut' },
  headphonesPreEq: { label: 'Headphones pre EQ', file: 'djm', offset: 14, choices: { 'post EQ': 0x80, 'pre EQ': 0x81 }, default: 'post EQ' },
  headphonesMonoSplit: { label: 'Headphones mono split', file: 'djm', offset: 15, choices: { stereo: 0x80, 'mono split': 0x81 }, default: 'stereo' },
  beatFxQuantize: { label: 'Beat FX quantize', file: 'djm', offset: 16, choices: { off: 0x80, on: 0x81 }, default: 'on' },
  micLowCut: { label: 'Mic low cut', file: 'djm', offset: 17, choices: { off: 0x80, on: 0x81 }, default: 'on' },
  talkOverMode: { label: 'Talk over mode', file: 'djm', offset: 18, choices: { advanced: 0x80, normal: 0x81 }, default: 'advanced' },
  talkOverLevel: { label: 'Talk over level', file: 'djm', offset: 19, choices: { '-24 dB': 0x80, '-18 dB': 0x81, '-12 dB': 0x82, '-6 dB': 0x83 }, default: '-18 dB' },
  midiChannel: { label: 'MIDI channel', file: 'djm', offset: 20, choices: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i + 1), 0x80 + i])), default: '1' },
  midiButtonType: { label: 'MIDI button type', file: 'djm', offset: 21, choices: { toggle: 0x80, trigger: 0x81 }, default: 'toggle' },
  displayBrightness: { label: 'Display brightness', file: 'djm', offset: 22, choices: { white: 0x80, 1: 0x81, 2: 0x82, 3: 0x83, 4: 0x84, 5: 0x85 }, default: '5' },
  indicatorBrightness: { label: 'Indicator brightness', file: 'djm', offset: 23, choices: { 1: 0x80, 2: 0x81, 3: 0x82 }, default: '3' },
  channelFaderCurveLong: { label: 'Channel fader curve (long fader)', file: 'djm', offset: 24, choices: { exponential: 0x80, smooth: 0x81, linear: 0x82 }, default: 'exponential' },
};

const FILES = {
  my: { name: 'MYSETTING.DAT', brand: 'PIONEER', version: '0.001', base: [0x78, 0x56, 0x34, 0x12, 0x02, 0, 0, 0, ...Array(32).fill(0)], len: 40,
    fixed: { 13: 0x01, 17: 0x01, 18: 0x01, 19: 0x01 } },
  my2: { name: 'MYSETTING2.DAT', brand: 'PIONEER', version: '0.001', base: Array(40).fill(0), len: 40, fixed: { 11: 0x81 } },
  // Five trailing values written by rekordbox 7 after the documented mixer options are kept as is.
  djm: { name: 'DJMMYSETTING.DAT', brand: 'PioneerDJ', version: '1.000', base: [0x78, 0x56, 0x34, 0x12, 0x01, 0, 0, 0, 0x20, 0, 0, 0, ...Array(40).fill(0)], len: 52,
    fixed: { 25: 0x80, 26: 0x82, 27: 0x84, 28: 0x81, 29: 0x81 } },
  dev: { name: 'DEVSETTING.DAT', brand: 'PIONEER DJ', version: '7.2.11', base: [0x78, 0x56, 0x34, 0x12, 0x01, 0, 0, 0, ...Array(24).fill(0)], len: 32,
    fixed: { 8: 0x01, 11: 0x01 } },
};

/** CRC16-XMODEM (polynomial 0x1021, initial value 0). */
export function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function defaultSettings() {
  return Object.fromEntries([...Object.entries(PLAYER_SETTINGS), ...Object.entries(MIXER_SETTINGS)].map(([k, d]) => [k, d.default]));
}

/**
 * Build the four files from chosen option names.
 * @param {Record<string, string>} values option key -> choice name (missing = default)
 * @returns {Record<string, Uint8Array>} file name -> bytes
 */
// Choice names saved by earlier versions.
const LEGACY_CHOICES = { CDJ: 'pitch bend', 'rekordbox setting': 'per-track setting' };

export function buildSettingFiles(values = {}) {
  const all = { ...PLAYER_SETTINGS, ...MIXER_SETTINGS };
  const out = {};
  for (const [id, f] of Object.entries(FILES)) {
    const data = Uint8Array.from(f.base);
    for (const [o, v] of Object.entries(f.fixed)) data[Number(o)] = v;
    for (const [key, def] of Object.entries(all)) {
      if (def.file !== id) continue;
      const choice = LEGACY_CHOICES[values[key]] ?? values[key] ?? def.default;
      data[def.offset] = def.choices[choice] ?? def.choices[def.default];
    }
    const buf = new Uint8Array(104 + f.len + 4);
    const v = new DataView(buf.buffer);
    v.setUint32(0, 0x60, true);
    [f.brand, 'rekordbox', f.version].forEach((s, i) => { for (let k = 0; k < s.length; k++) buf[4 + i * 32 + k] = s.charCodeAt(k); });
    v.setUint32(100, f.len, true);
    buf.set(data, 104);
    v.setUint16(104 + f.len, crc16xmodem(id === 'djm' ? buf.subarray(0, 104 + f.len) : data), true);
    out[f.name] = buf;
  }
  return out;
}
