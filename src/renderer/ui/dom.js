// Tiny DOM helpers and shared widgets (knob, context menu, dialogs, toasts).

/**
 * h('div.cls#id', {attrs/props/on*}, ...children)
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const [name, ...parts] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const p of parts) {
    if (p[0] === '.') el.classList.add(p.slice(1));
    else el.id = p.slice(1);
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const fmtTime = (sec, tenths = false) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const t = tenths ? `.${Math.floor((sec * 10) % 10)}` : '';
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${t}`;
};

/**
 * Rotary knob: vertical drag changes value, double-click resets, wheel nudges.
 * @param {{label?: string, min: number, max: number, value: number, reset?: number, step?: number,
 *          format?: (v: number) => string, onInput: (v: number) => void, size?: 'sm'|'md'}} o
 */
export function knob(o) {
  const reset = o.reset ?? o.value;
  let value = o.value;
  const indicator = h('div.knob-ind');
  const dial = h('div.knob-dial', { tabIndex: 0, title: o.label ?? '' }, indicator);
  const readout = h('div.knob-val');
  const el = h(`div.knob.${o.size ?? 'md'}`, {}, dial, o.label ? h('div.knob-label', {}, o.label) : null, o.format ? readout : null);
  const render = () => {
    const t = (value - o.min) / (o.max - o.min);
    indicator.style.transform = `rotate(${-135 + t * 270}deg)`;
    // Value arc: from the centre for bipolar knobs (EQ, trim, colour), else from the minimum.
    const r = (reset - o.min) / (o.max - o.min);
    const from = r > 0.01 && r < 0.99 ? Math.min(r, t) : 0;
    const to = r > 0.01 && r < 0.99 ? Math.max(r, t) : t;
    dial.style.setProperty('--a0', `${from * 270}deg`);
    dial.style.setProperty('--a1', `${to * 270}deg`);
    if (o.format) readout.textContent = o.format(value);
  };
  const set = (v, notify = true) => {
    const step = o.step ?? 0;
    let x = Math.max(o.min, Math.min(o.max, v));
    if (step) x = Math.round(x / step) * step;
    if (Math.abs(x - reset) < (o.max - o.min) * 0.015) x = reset; // detent at centre/default
    value = x;
    render();
    if (notify) o.onInput(value);
  };
  dial.addEventListener('pointerdown', (e) => {
    dial.setPointerCapture(e.pointerId);
    const startY = e.clientY; const start = value;
    const move = (ev) => set(start + ((startY - ev.clientY) / (ev.shiftKey ? 600 : 150)) * (o.max - o.min));
    const up = () => { dial.removeEventListener('pointermove', move); dial.removeEventListener('pointerup', up); };
    dial.addEventListener('pointermove', move);
    dial.addEventListener('pointerup', up);
  });
  dial.addEventListener('dblclick', () => set(reset));
  dial.addEventListener('wheel', (e) => { e.preventDefault(); set(value - Math.sign(e.deltaY) * (o.max - o.min) / 50); }, { passive: false });
  render();
  el.setValue = (v) => set(v, false);
  return el;
}

/** Vertical or horizontal fader built on <input type=range>. */
export function fader({ min = 0, max = 1, step = 0.001, value, vertical = false, onInput, cls = '', reset }) {
  const el = h(`input.fader${vertical ? '.vertical' : ''}${cls ? `.${cls}` : ''}`, { type: 'range', min, max, step, value });
  el.addEventListener('input', () => onInput(Number(el.value)));
  if (reset !== undefined) el.addEventListener('dblclick', () => { el.value = reset; onInput(reset); });
  return el;
}

let openMenu = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

/**
 * @param {number} x
 * @param {number} y
 * @param {({label: string, action?: () => void, submenu?: any[], disabled?: boolean, checked?: boolean} | '-')[]} items
 */
export function contextMenu(x, y, items) {
  closeMenu();
  const build = (list) => h('ul.menu', {}, list.map((it) => {
    if (it === '-') return h('li.sep');
    const li = h(`li${it.disabled ? '.disabled' : ''}${it.submenu ? '.has-sub' : ''}`, {},
      h('span.check', {}, it.checked ? '✓' : ''), h('span', {}, it.label));
    if (it.submenu) li.append(build(it.submenu));
    else if (!it.disabled) li.addEventListener('click', () => { closeMenu(); it.action?.(); });
    return li;
  }));
  openMenu = build(items);
  openMenu.classList.add('root');
  document.body.append(openMenu);
  const r = openMenu.getBoundingClientRect();
  openMenu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  openMenu.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
}

/** Modal with custom body; resolves with the value passed to close(). */
export function modal(title, body, buttons = [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: null }]) {
  return new Promise((resolve) => {
    const close = (v) => { overlay.remove(); resolve(v); };
    const content = typeof body === 'function' ? body(close) : body;
    const overlay = h('div.overlay', { onpointerdown: (e) => { if (e.target === overlay) close(null); } },
      h('div.dialog', { role: 'dialog' },
        h('h2', {}, title),
        h('div.dialog-body', {}, content),
        h('div.dialog-buttons', {}, buttons.map((b) => h(`button${b.primary ? '.primary' : ''}`, {
          onclick: () => close(typeof b.value === 'function' ? b.value() : b.value),
        }, b.label)))));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const primary = buttons.find((b) => b.primary);
        if (primary) close(typeof primary.value === 'function' ? primary.value() : primary.value);
      }
      e.stopPropagation();
    });
    document.body.append(overlay);
    (overlay.querySelector('input,select,textarea,button.primary'))?.focus();
  });
}

export async function promptText(title, value = '') {
  const input = h('input.text', { value, spellcheck: false });
  setTimeout(() => { input.focus(); input.select(); });
  const r = await modal(title, input, [{ label: 'OK', primary: true, value: () => input.value.trim() }, { label: 'Cancel', value: null }]);
  return r || null;
}

export function confirmDialog(title, text) {
  return modal(title, h('p', {}, text), [{ label: 'OK', primary: true, value: true }, { label: 'Cancel', value: false }]);
}

export function toast(text, ms = 3000) {
  let host = document.querySelector('.toasts');
  if (!host) { host = h('div.toasts'); document.body.append(host); }
  const t = h('div.toast', {}, text);
  host.append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}
