// Licence: Preferences > About section, the beta / trial pill in the top bar, and the dialog shown when a
// key is needed: to join the open beta (free beta key), when the beta is over (beta testers see their
// discount), when the trial is over or the key no longer works. It only closes once a key is activated.
// "Buy me a coffee" donations wherever a donation link is set.
import { h, toast } from './dom.js';
import { LINKS } from './updates.js';

const cleanError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const buyUrl = (st) => st?.product?.buyUrl || LINKS.website;
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const betaDate = (st) => (st?.product?.betaEndsAt ? new Date(`${st.product.betaEndsAt}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

export function statusText(st) {
  if (!st) return '';
  if (st.mode === 'dev') return 'Developer build (run from the source): no licence needed.';
  if (st.mode === 'licensed') return `Lifetime licence${st.customer ? ` of ${st.customer}` : ''} (key ${st.key}). Thank you!`;
  if (st.mode === 'beta') return `Open beta${st.registered ? ` (beta key ${st.key})` : ''}: free until ${betaDate(st)} (${plural(st.daysLeft, 'day')} left).`;
  if (st.mode === 'trial') return `Free trial: ${plural(st.daysLeft, 'day')} left.`;
  return {
    betaKey: `Reboxed is free during the open beta, until ${betaDate(st)}. Get your free beta key, then paste it here.`,
    betaOver: 'The open beta is over. Thank you for testing Reboxed!',
    trial: 'The free trial is over.',
    revoked: 'This licence key is no longer valid.',
    offline: 'The licence could not be checked for 30 days: connect to the internet once.',
    clock: 'The computer clock was set back.',
  }[st.reason] ?? 'No valid licence.';
}

/** "Buy me a coffee" button, or null while no donation link is set. */
export function donateButton(st, cls = 'button.dbtn') {
  const url = st?.product?.donateUrl;
  return url ? h(cls, { type: 'button', title: 'Support Reboxed with a donation', onclick: () => window.rb.openExternal(url) }, '☕ Buy me a coffee') : null;
}

/** Key field + Activate; calls done(status) after a successful activation. */
function keyForm(done, placeholder = 'Licence key (from your purchase e-mail)') {
  const input = h('input.text.license-key', { type: 'text', placeholder, spellcheck: 'false' });
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
    const free = st.key ? h('button.dbtn', { type: 'button', title: 'Frees this computer so the key can be activated on another one' }, 'Deactivate on this computer') : null;
    if (free) free.onclick = async () => { if (confirm('Deactivate the key on this computer?')) render(await window.rb.license.deactivate()); };
    if (st.mode === 'licensed' || st.mode === 'dev') {
      box.replaceChildren(h('div.about-ok.license-status', {}, `✓ ${statusText(st)}`), h('div.frow', {}, free, donateButton(st)));
    } else {
      const form = keyForm((s) => { toast(s.mode === 'beta' ? 'Beta key activated: welcome to the beta!' : 'Licence activated: thank you!'); render(s); });
      box.replaceChildren(h('div.license-status', {}, statusText(st)), form.el, h('div.frow', {}, buy, free, donateButton(st)));
    }
  };
  window.rb.license.status().then(render);
  return box;
}

/** A key is needed (beta key, licence after the beta / trial, key refused): stays until one works. */
export function openLicenseGate(app, st) {
  if (document.querySelector('.license-gate')) return;
  const joining = st.reason === 'betaKey';
  const form = keyForm((s) => {
    if (s.mode === 'expired') { openLicenseGate(app, s); overlay.remove(); return; }
    overlay.remove();
    app.applyLicense(s);
    toast(s.mode === 'beta' ? 'Beta key activated: welcome to the beta!' : 'Licence activated: thank you!');
  }, joining ? 'Beta key (from the e-mail)' : 'Licence key (from your purchase e-mail)');
  const discount = st.reason === 'betaOver' && st.betaTester && st.product.betaDiscount
    ? h('p.license-discount', {}, `🎁 Beta tester discount: ${st.product.betaDiscount}`) : null;
  const overlay = h('div.overlay.license-gate', {},
    h('div.dialog', { role: 'dialog' },
      h('h2', {}, joining ? 'Join the open beta' : st.reason === 'betaOver' ? 'Thank you for the beta!' : 'Activate Reboxed'),
      h('div.dialog-body', {},
        h('p', {}, statusText(st)),
        discount,
        joining ? h('p.dim', {}, 'The beta key is free: it only asks for your e-mail.')
          : h('p.dim', {}, `The lifetime licence costs ${st.product.price}, paid once: every update included. Your library, cues and settings are kept.`),
        form.el),
      h('div.dialog-buttons', {},
        h('button', { onclick: () => window.close() }, 'Quit'),
        donateButton(st, 'button'),
        joining ? h('button.primary', { onclick: () => window.rb.openExternal(st.product.betaUrl) }, 'Get my free beta key')
          : h('button.primary', { onclick: () => window.rb.openExternal(buyUrl(st)) }, `Buy (${st.product.price})`))));
  overlay.addEventListener('keydown', (e) => e.stopPropagation(), true);
  document.body.append(overlay);
  form.input.focus();
}
