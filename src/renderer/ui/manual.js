// Built-in manual (top bar ▸ ?): every menu explained. The text is a local file (renderer/manual.html),
// shown in a window inside the app; it is not published online.
import { h } from './dom.js';

export async function openManual() {
  const body = h('div.manual-win');
  const close = () => overlay.remove();
  const overlay = h('div.overlay', { onclick: (e) => { if (e.target === overlay) close(); } },
    h('div.dialog.manual-dialog', { role: 'dialog' },
      h('div.manual-head', {}, h('h2', {}, 'Manuel'), h('button.dbtn.small', { onclick: close }, 'Close')), body));
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
  document.body.append(overlay);
  try {
    // Our own file (same origin, app://rb): safe to insert as HTML.
    body.innerHTML = await (await fetch('manual.html')).text();
  } catch (err) {
    body.textContent = `Manual unavailable: ${err.message}`;
  }
  // Table of contents: scroll inside the window (no navigation).
  body.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const target = body.querySelector(a.getAttribute('href'));
    if (target) body.querySelector('.manual-body').scrollTop = target.offsetTop - 8;
  });
  overlay.tabIndex = -1;
  overlay.focus();
  return overlay;
}
