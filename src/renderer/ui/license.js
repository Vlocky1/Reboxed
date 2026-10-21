// Licence: Preferences > About section, the beta / trial pill in the top bar, the thank-you note when the
// open beta ends, and the dialog shown when the trial is over (or the key no longer works), which only
// closes once a key is activated. "Buy me a coffee" donations wherever a donation link is set.
import { h, toast, modal } from './dom.js';
import { LINKS } from './updates.js';

const cleanError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const buyUrl = (st) => st?.product?.buyUrl || LINKS.website;
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const betaDate = (st) => (st?.product?.betaEndsAt ? new Date(`${st.product.betaEndsAt}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

export function statusText(st) {
  if (!st) return '';
  if (st.mode === 'dev') return 'Developer build (run from the source): no licence needed.';
  if (st.mode === 'licensed') return `Licensed${st.customer ? ` to ${st.customer}` : ''} (key ${st.key}). Thank you!`;
  if (st.mode === 'beta') return `Open beta: free until ${betaDate(st)} (${plural(st.daysLeft, 'day')} left).`;
  if (st.mode === 'trial') return st.afterBeta ? `The open beta is over: ${plural(st.daysLeft, 'day')} left to get a licence.` : `Free trial: ${plural(st.daysLeft, 'day')} left.`;
  return {
    trial: 'The free trial is over.',
    revoked: 'This licence key is no longer valid.',
    offline: 'The licence could not be checked for 30 days: connect to the internet once.',
    clock: 'The computer clock was set back: the trial is over.',
  }[st.reason] ?? 'No valid licence.';
}

/** "Buy me a coffee" button, or null while no donation link is set. */
export function donateButton(st, cls = 'button.dbtn') {
  const url = st?.product?.donateUrl;
  return url ? h(cls, { type: 'button', title: 'Support Reboxed with a donation', onclick: () => window.rb.openExternal(url) }, '☕ Buy me a coffee') : null;
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

/** Preferences > About: licence status, activate / move to another computer, buy, donate. */
export function licenseSection(app) {
  const box = h('div.license-section');
  const render = (st) => {
    app.applyLicense?.(st);
    const buy = h('button.dbtn', { type: 'button', onclick: () => window.rb.openExternal(buyUrl(st)) }, `Lifetime licence (${st.product.price})`);
    if (st.mode === 'licensed' || st.mode === 'dev') {
      const free = st.mode === 'licensed' ? h('button.dbtn', { type: 'button', title: 'Frees this computer so the key can be activated on another one' }, 'Deactivate on this computer') : null;
      if (free) free.onclick = async () => { if (confirm('Deactivate the licence on this computer?')) render(await window.rb.license.deactivate()); };
      box.replaceChildren(h('div.about-ok.license-status', {}, `✓ ${statusText(st)}`), h('div.frow', {}, free, donateButton(st)));
    } else {
      const form = keyForm((s) => { toast('Licence activated: thank you!'); render(s); });
      box.replaceChildren(h('div.license-status', {}, statusText(st)), form.el, h('div.frow', {}, buy, donateButton(st)));
    }
  };
  window.rb.license.status().then(render);
  return box;
}

/** The open beta just ended: thank the tester once, with the licence and donation links. */
export async function showBetaOver(app, st) {
  if (app.library.settings.betaOverShown) return;
  app.library.setSetting('betaOverShown', true);
  const choice = await modal('The open beta is over', h('div', {},
    h('p', {}, 'Thank you for testing Reboxed! Your library, cues and settings stay as they are.'),
    h('p.dim', {}, `You have ${plural(st.daysLeft, 'more day')} to get the lifetime licence (${st.product.price}, paid once, every update included). You can also support the project with a coffee.`)),
  [
    { label: 'Later', value: null },
    ...(st.product.donateUrl ? [{ label: '☕ Buy me a coffee', value: 'donate' }] : []),
    { label: `Get the licence (${st.product.price})`, primary: true, value: 'buy' },
  ]);
  if (choice === 'buy') window.rb.openExternal(buyUrl(st));
  if (choice === 'donate') window.rb.openExternal(st.product.donateUrl);
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
        h('p.dim', {}, `The lifetime licence costs ${st.product.price}, paid once: every update included. Your library, cues and settings are kept.`),
        form.el),
      h('div.dialog-buttons', {},
        h('button', { onclick: () => window.close() }, 'Quit'),
        donateButton(st, 'button'),
        h('button.primary', { onclick: () => window.rb.openExternal(buyUrl(st)) }, `Buy (${st.product.price})`))));
  overlay.addEventListener('keydown', (e) => e.stopPropagation(), true);
  document.body.append(overlay);
  form.input.focus();
}
