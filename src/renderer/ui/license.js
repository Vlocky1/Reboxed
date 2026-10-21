// Licence: Preferences > About section, the trial pill in the top bar and the dialog shown when the
// trial is over (or the key no longer works), which only closes once a key is activated.
import { h, toast } from './dom.js';
import { LINKS } from './updates.js';

const cleanError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const buyUrl = (st) => st?.product?.buyUrl || LINKS.website;

export function statusText(st) {
  if (!st) return '';
  if (st.mode === 'licensed') return `Licensed${st.customer ? ` to ${st.customer}` : ''} (key ${st.key}).`;
  if (st.mode === 'trial') return `Free trial: ${st.daysLeft} day${st.daysLeft > 1 ? 's' : ''} left.`;
  return {
    trial: 'The free trial is over.',
    revoked: 'This licence key is no longer valid.',
    offline: 'The licence could not be checked for 30 days: connect to the internet once.',
    clock: 'The computer clock was set back: the trial is over.',
  }[st.reason] ?? 'No valid licence.';
}

/** Key field + Activate; calls done(status) after a successful activation. */
function keyForm(done) {
  const input = h('input.text.license-key', { type: 'text', placeholder: 'Licence key (from your purchase e-mail)', spellcheck: 'false' });
  const err = h('div.rbi-error.license-error');
  const go = h('button.dbtn.primary', { type: 'button' }, 'Activate');
  go.onclick = async () => {
    go.disabled = true;
    err.textContent = '';
    try { done(await window.rb.license.activate(input.value)); } catch (e) { err.textContent = cleanError(e); }
    go.disabled = false;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); e.stopPropagation(); });
  return { el: h('div.license-form', {}, h('div.frow', {}, input, go), err), input };
}

/** Preferences > About: licence status, activate / move to another computer, buy. */
export function licenseSection(app) {
  const box = h('div.license-section');
  const render = (st) => {
    app.applyLicense?.(st);
    const buy = h('button.dbtn', { type: 'button', onclick: () => window.rb.openExternal(buyUrl(st)) }, `Buy Reboxed (${st.product.price})`);
    if (st.mode === 'licensed') {
      const free = h('button.dbtn', { type: 'button', title: 'Frees this computer so the key can be activated on another one' }, 'Deactivate on this computer');
      free.onclick = async () => { if (confirm('Deactivate the licence on this computer?')) render(await window.rb.license.deactivate()); };
      box.replaceChildren(h('div.about-ok.license-status', {}, `✓ ${statusText(st)}`), h('div.frow', {}, free));
    } else {
      const form = keyForm((s) => { toast('Licence activated: thank you!'); render(s); });
      box.replaceChildren(h('div.license-status', {}, statusText(st)), form.el, h('div.frow', {}, buy));
    }
  };
  window.rb.license.status().then(render);
  return box;
}

/** Trial over / key refused: a dialog that stays until a key works (or Reboxed is closed). */
export function openLicenseGate(app, st) {
  if (document.querySelector('.license-gate')) return;
  const form = keyForm((s) => { overlay.remove(); app.applyLicense(s); toast('Licence activated: thank you!'); });
  const overlay = h('div.overlay.license-gate', {},
    h('div.dialog', { role: 'dialog' },
      h('h2', {}, 'Activate Reboxed'),
      h('div.dialog-body', {},
        h('p', {}, statusText(st)),
        h('p.dim', {}, `Reboxed costs ${st.product.price}, paid once: every update included. Your library, cues and settings are kept.`),
        form.el),
      h('div.dialog-buttons', {},
        h('button', { onclick: () => window.close() }, 'Quit'),
        h('button.primary', { onclick: () => window.rb.openExternal(buyUrl(st)) }, `Buy (${st.product.price})`))));
  overlay.addEventListener('keydown', (e) => e.stopPropagation(), true);
  document.body.append(overlay);
  form.input.focus();
}
