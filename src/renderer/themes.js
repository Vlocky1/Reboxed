// Interface themes: each one sets the colour variables of styles.css (:root). Settings:
// theme (id), themeAccent (null = the theme's own), uiScale (zoom), topbarLabels ('full' | 'icons').

const base = {
  '--bg-0': '#0a0a0b', '--bg': '#0e0e0f', '--bg-2': '#141415', '--panel': '#1b1b1d', '--panel-2': '#232326', '--panel-3': '#2b2b2f',
  '--line': '#2f2f33', '--line-2': '#3a3a3f', '--text': '#e8e8ea', '--text-2': '#b4b4b8', '--dim': '#7d7d82', '--faint': '#55555a',
  '--accent': '#1473eb', '--accent-2': '#3d8dff', '--on': '#f29b26', '--cue': '#f29b26', '--wave-bg': '#0b0c0e',
};

/** Builds the 12 grey steps from a background, a panel and a text colour (mixed in sRGB). */
function scale(bg, panel, text) {
  const mix = (a, b, t) => {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [x, y] = [p(a), p(b)];
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  };
  return {
    '--bg-0': mix(bg, '#000000', 0.25), '--bg': bg, '--bg-2': mix(bg, panel, 0.5), '--panel': panel,
    '--panel-2': mix(panel, text, 0.04), '--panel-3': mix(panel, text, 0.08), '--line': mix(panel, text, 0.1), '--line-2': mix(panel, text, 0.16),
    '--faint': mix(panel, text, 0.3), '--dim': mix(panel, text, 0.5), '--text-2': mix(panel, text, 0.75), '--text': text,
    '--wave-bg': mix(bg, '#000000', 0.2),
  };
}

export const THEMES = [
  { id: 'dark', name: 'Reboxed Dark', vars: base },
  { id: 'oled', name: 'OLED Black', vars: { ...scale('#000000', '#0c0c0d', '#ececee'), '--accent': '#1f7aff', '--accent-2': '#5aa0ff', '--wave-bg': '#000000' } },
  { id: 'midnight', name: 'Midnight', vars: { ...scale('#0b1020', '#131a2e', '#e3e9f7'), '--accent': '#19b5d8', '--accent-2': '#5fd4ee', '--on': '#ffb648', '--cue': '#ffb648' } },
  { id: 'graphite', name: 'Graphite', vars: { ...scale('#1d1e21', '#2a2b2f', '#f0f0f2'), '--accent': '#4f8cff', '--accent-2': '#7eaaff' } },
  { id: 'ember', name: 'Ember', vars: { ...scale('#120d0a', '#1e1712', '#f3e8de'), '--accent': '#e8762b', '--accent-2': '#ff9d5c', '--on': '#ffc24a', '--cue': '#ffc24a' } },
  { id: 'neon', name: 'Neon', vars: { ...scale('#0d0815', '#170f24', '#efe6ff'), '--accent': '#d43dff', '--accent-2': '#e57dff', '--on': '#2ef2c9', '--cue': '#2ef2c9' } },
  { id: 'forest', name: 'Forest', vars: { ...scale('#0a110d', '#121c16', '#e4f1e8'), '--accent': '#2fbf71', '--accent-2': '#5fdc95', '--on': '#f2c12e', '--cue': '#f2c12e' } },
  { id: 'rose', name: 'Rosé', vars: { ...scale('#140c10', '#21141a', '#f7e6ee'), '--accent': '#ff4f8b', '--accent-2': '#ff85ad' } },
];

/** Accent colours offered on top of any theme (null = the theme's own). */
export const ACCENTS = ['#1473eb', '#19b5d8', '#2fbf71', '#c6e630', '#f2c12e', '#e8762b', '#fa233b', '#ff4f8b', '#d43dff', '#8a6cff'];

export const UI_SCALES = [[0.85, 'Small (85 %)'], [0.92, 'Compact (92 %)'], [1, 'Normal (100 %)'], [1.1, 'Large (110 %)'], [1.25, 'Extra large (125 %)']];

const lighten = (hex, t) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) + (255 - parseInt(hex.slice(i, i + 2), 16)) * t).toString(16).padStart(2, '0')).join('')}`;

/** Colour variables for these settings. */
export function themeVars(settings = {}) {
  const theme = THEMES.find((t) => t.id === settings.theme) ?? THEMES[0];
  const vars = { ...base, ...theme.vars };
  if (settings.themeAccent) { vars['--accent'] = settings.themeAccent; vars['--accent-2'] = lighten(settings.themeAccent, 0.25); }
  return vars;
}

/** Apply theme, accent, size and top bar style to the page. */
export function applyTheme(settings = {}) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeVars(settings))) root.style.setProperty(k, v);
  root.dataset.theme = settings.theme ?? 'dark';
  document.body?.classList.toggle('gbar-icons', settings.topbarLabels === 'icons');
  window.rb?.setZoom?.(settings.uiScale || 1);
  window.dispatchEvent(new Event('reboxed-theme'));
}
