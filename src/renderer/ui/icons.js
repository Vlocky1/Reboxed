// Reboxed's own icon set (simple geometric SVGs, 16x16 grid, currentColor).
const svg = (body, vb = 16) => `<svg viewBox="0 0 ${vb} ${vb}" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  play: svg('<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="4" y="3.5" width="2.6" height="9" rx=".5" fill="currentColor" stroke="none"/><rect x="9.4" y="3.5" width="2.6" height="9" rx=".5" fill="currentColor" stroke="none"/>'),
  playpause: svg('<path d="M2.5 4v8l5-4z" fill="currentColor" stroke="none"/><rect x="9" y="4" width="1.8" height="8" fill="currentColor" stroke="none"/><rect x="12" y="4" width="1.8" height="8" fill="currentColor" stroke="none"/>'),
  headphones: svg('<path d="M3 10V8a5 5 0 0 1 10 0v2"/><rect x="2.5" y="9.5" width="3" height="4" rx="1"/><rect x="10.5" y="9.5" width="3" height="4" rx="1"/>'),
  palette: svg('<path d="M8 2a6 6 0 1 0 0 12c1 0 1.4-.7 1.1-1.5-.3-.9.2-1.8 1.2-1.8H12a2.2 2.2 0 0 0 2-2.2A6 6 0 0 0 8 2z"/><circle cx="5" cy="7" r=".9" fill="currentColor" stroke="none"/><circle cx="7.5" cy="4.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10.6" cy="5.6" r=".9" fill="currentColor" stroke="none"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>'),
  fx: svg('<path d="M2 12c2-8 4-8 6 0s4 8 6 0" />'),
  sampler: svg('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor"/>'),
  mixer: svg('<path d="M4 2v12M8 2v12M12 2v12"/><rect x="2.5" y="8" width="3" height="2" rx=".5" fill="currentColor"/><rect x="6.5" y="4" width="3" height="2" rx=".5" fill="currentColor"/><rect x="10.5" y="10" width="3" height="2" rx=".5" fill="currentColor"/>'),
  trash: svg('<path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5"/><path d="M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.8 7v4.5M9.2 7v4.5"/>'),
  download: svg('<path d="M8 2v8M4.5 6.5L8 10l3.5-3.5"/><path d="M2.5 11.5v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.5"/>'),
  rec: svg('<circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none"/>'),
  link: svg('<path d="M6.5 9.5l3-3"/><path d="M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2"/><path d="M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"/>'),
  automix: svg('<path d="M2 5h8l-2-2M14 11H6l2 2"/>'),
  layout2: svg('<rect x="1.5" y="3" width="13" height="3.5" rx=".8"/><rect x="1.5" y="9.5" width="13" height="3.5" rx=".8"/>'),
  layout4: svg('<rect x="1.5" y="2" width="13" height="2" rx=".5"/><rect x="1.5" y="5.5" width="13" height="2" rx=".5"/><rect x="1.5" y="9" width="13" height="2" rx=".5"/><rect x="1.5" y="12.5" width="13" height="2" rx=".5"/>'),
  browser: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M5.5 2.5v11M7.5 6h5M7.5 8.5h5M7.5 11h5"/>'),
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.6 3.6"/>'),
  folder: svg('<path d="M1.8 4.5a1 1 0 0 1 1-1h3.4l1.4 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>'),
  playlist: svg('<path d="M2 4h8M2 7.5h8M2 11h5"/><path d="M12 3v7.5"/><circle cx="10.6" cy="11" r="1.6"/>'),
  smart: svg('<path d="M2 4h6M2 7.5h5M2 11h4"/><path d="M12 6l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z" fill="currentColor"/>'),
  history: svg('<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.3 1.5"/>'),
  collection: svg('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/>'),
  tag: svg('<path d="M2 2.5h5.5l6.5 6.5-5 5L2.5 7.5z"/><circle cx="5" cy="5" r="1" fill="currentColor"/>'),
  related: svg('<path d="M3 5h9l-2.5-2.5M13 11H4l2.5 2.5"/>'),
  suggest: svg('<path d="M1.5 9c1.5-3 2.5-3 4 0s2.5 3 4 0 2.5-3 4 0" />'),
  midi: svg('<circle cx="8" cy="8" r="6"/><circle cx="5" cy="7" r=".9" fill="currentColor"/><circle cx="8" cy="5" r=".9" fill="currentColor"/><circle cx="11" cy="7" r=".9" fill="currentColor"/><circle cx="6" cy="10" r=".9" fill="currentColor"/><circle cx="10" cy="10" r=".9" fill="currentColor"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  more: svg('<circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/>'),
  grid: svg('<path d="M3 2v12M6.5 2v12M10 2v12M13.5 2v12" stroke-width="1.2"/><path d="M1.5 8h13" stroke-dasharray="1.5 1.5"/>'),
  note: svg('<path d="M6 12V3.5l7-1.5v8.5"/><circle cx="4.4" cy="12" r="1.8"/><circle cx="11.4" cy="10.5" r="1.8"/>'),
  filter: svg('<path d="M2 3h12l-4.5 5.5V13l-3-1.5v-3z"/>'),
};

/** <span class="ico"> containing an icon. */
export function icon(name, cls = '') {
  const el = document.createElement('span');
  el.className = `ico${cls ? ` ${cls}` : ''}`;
  el.innerHTML = ICONS[name] ?? '';
  return el;
}
