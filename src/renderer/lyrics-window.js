// The lyrics window (lyrics.html, its own OS window: move it to another screen, F11 for full screen).
// It follows the deck on air (or a chosen deck) through the decks' window (ui/lyrics-link.js), shows the
// line sung now, and has a manual sync mode: play the track, tap SPACE at the start of each line, fine
// tune, save with the track. Lyrics synced by hand are never replaced by an automatic search.
import { h } from './ui/dom.js';
import { LYRICS_CHANNEL, formatStamp, lineAt, lineProgress, parseLrc, plainLines, titleVariants, mainArtist, toLrc } from '../shared/lrc.js';

const ch = new BroadcastChannel(LYRICS_CHANNEL);
const now = () => performance.timeOrigin + performance.now();
const store = {
  get(k, d) { try { const v = localStorage.getItem(`lyrics.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`lyrics.${k}`, JSON.stringify(v)); } catch { /* private storage off */ } },
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const S = {
  state: null,
  follow: store.get('follow', 'auto'),                 // 'auto' or a deck index
  deck: null, candidate: null, candidateSince: 0,
  trackId: null, status: 'idle', lyrics: null, error: '',
  lines: [], plain: null, offset: 0,
  mode: 'view', edit: null,
  size: store.get('size', 44), onTop: false, full: false,
  shownLine: -2, searches: new Map(),
};

// ---- layout ----------------------------------------------------------------------------------------
const el = {};
el.deckSeg = h('div.seg');
el.track = h('div.ly-track');
el.badge = h('span.badge');
el.offVal = h('span');
el.offset = h('div.offset', { title: 'Shift the lyrics: − sooner, + later ( [ and ] keys, Shift = 1 s)' },
  h('button', { onclick: (e) => shiftOffset(e.shiftKey ? -1 : -0.1) }, '−'), el.offVal, h('button', { onclick: (e) => shiftOffset(e.shiftKey ? 1 : 0.1) }, '+'));
el.syncBtn = h('button', { title: 'Sync the lyrics by hand: tap SPACE at the start of each line', onclick: () => enterEdit() }, 'SYNC');
el.searchBtn = h('button', { title: 'Find other lyrics, or paste your own', onclick: () => openSearch() }, 'SEARCH');
el.topBtn = h('button', { title: 'Keep this window in front of the others', onclick: () => setWin({ onTop: !S.onTop }) }, 'ON TOP');
el.fullBtn = h('button', { title: 'Full screen (F11)', onclick: () => setWin({ fullscreen: !S.full }) }, 'FULL SCREEN');
el.head = h('div.ly-head', {},
  el.deckSeg, el.track, el.badge, el.offset, el.syncBtn, el.searchBtn,
  h('button', { title: 'Smaller text', onclick: () => setSize(S.size - 4) }, 'A−'),
  h('button', { title: 'Bigger text', onclick: () => setSize(S.size + 4) }, 'A+'),
  el.topBtn, el.fullBtn);
el.note = h('div.ly-note', { hidden: true });
el.lines = h('div.ly-lines');
el.plain = h('div.ly-plain', { hidden: true });
el.empty = h('div.ly-empty', { hidden: true });
el.view = h('div.ly-view', {}, el.lines, el.plain, el.empty);
el.edit = h('div.ed', { hidden: true });
el.root = h('div.ly', {}, el.head, el.note, el.view, el.edit);
document.body.replaceChildren(el.root);
setSize(S.size);

// ---- talking to the decks' window -------------------------------------------------------------------
const post = (m) => { try { ch.postMessage(m); } catch { /* closed */ } };
ch.onmessage = (e) => onMessage(e.data ?? {});
post({ type: 'hello' });
setInterval(() => post({ type: 'alive' }), 1000);
setWin({});

function onMessage(m) {
  if (m.type === 'state') { S.state = m; pickDeck(); }
  else if (m.type === 'lyrics' && m.trackId === S.trackId) setLyrics(m);
  else if (m.type === 'changed' && m.trackId === S.trackId && S.mode === 'view') post({ type: 'get', trackId: S.trackId });
  else if (m.type === 'results') { S.searches.get(m.id)?.(m); S.searches.delete(m.id); }
}

/** The deck to follow: the chosen one, or the deck on air (after it stays on air for a moment). */
function pickDeck() {
  const st = S.state;
  if (!st) return;
  if (S.mode === 'edit') { renderHead(); return; }      // the editor stays on its track
  let want = S.follow === 'auto' ? st.onAir : Number(S.follow);
  if (!st.decks[want]) want = st.onAir ?? 0;
  if (S.follow === 'auto' && S.deck !== null && want !== S.deck) {
    if (S.candidate !== want) { S.candidate = want; S.candidateSince = now(); want = S.deck; }
    else if (now() - S.candidateSince < 1200) want = S.deck;
  }
  S.deck = want;
  const tid = st.decks[want]?.trackId ?? null;
  if (tid !== S.trackId) {
    S.trackId = tid; S.lyrics = null; S.lines = []; S.plain = null; S.offset = 0; S.shownLine = -2;
    S.status = tid ? 'loading' : 'idle';
    if (tid) post({ type: 'get', trackId: tid });
    renderBody();
  }
  renderHead();
}

const deckInfo = (i = S.deck) => S.state?.decks?.[i] ?? null;
/** The play head now, from the last report (20 a second) moved on by the time since. */
function position(i = S.deck) {
  const d = deckInfo(i);
  if (!d) return 0;
  const t = d.playing ? d.position + ((now() - S.state.at) / 1000) * d.speed : d.position;
  return Math.max(0, Math.min(d.duration || Infinity, t));
}

function setLyrics(m) {
  S.status = m.status; S.error = m.error ?? '';
  if (m.lyrics) {
    S.lyrics = m.lyrics;
    S.lines = m.lyrics.lrc ? parseLrc(m.lyrics.lrc) : [];
    S.plain = m.lyrics.plain ?? null;
    S.offset = Number(m.lyrics.offset) || 0;
  }
  S.shownLine = -2;
  renderBody(); renderHead();
}

// ---- header -----------------------------------------------------------------------------------------
let headSig = '';
function renderHead() {
  const decks = S.state?.decks ?? [];
  // rebuilt only when something it shows changed (the decks report 20 times a second)
  const dd = deckInfo();
  const sig = JSON.stringify([S.follow, S.deck, decks.map((d) => d.trackId), dd?.title, dd?.artist, Math.round(dd?.duration ?? 0), S.status, S.mode,
    S.lines.length, !!S.plain, S.lyrics?.edited, S.lyrics?.source, S.lyrics?.match?.duration, S.offset, S.onTop, S.full]);
  if (sig === headSig) return;
  headSig = sig;
  const btn = (key, label, title) => h(`button${String(S.follow) === String(key) ? '.on' : ''}`, { title, onclick: () => { S.follow = key; store.set('follow', key); S.candidate = null; pickDeck(); } }, label);
  el.deckSeg.replaceChildren(btn('auto', 'AUTO', 'Follow the deck on air'), ...decks.map((d) => btn(d.index, String(d.index + 1), `Deck ${d.index + 1}`)));
  const d = deckInfo();
  el.track.replaceChildren(...(d?.trackId ? [h('b', {}, d.title || 'Untitled'), d.artist ? `  ·  ${d.artist}` : ''] : [h('span.dim', {}, 'No track on this deck')]));
  const synced = S.lines.length > 0;
  const L = S.lyrics;
  el.badge.className = 'badge';
  if (S.mode === 'edit') { el.badge.textContent = 'SYNCING BY HAND'; el.badge.classList.add('hand'); }
  else if (S.status === 'loading') el.badge.textContent = 'SEARCHING…';
  else if (L?.instrumental && !synced && !S.plain) el.badge.textContent = 'INSTRUMENTAL';
  else if (synced) { el.badge.textContent = L?.edited ? 'SYNCED BY HAND' : `SYNCED · ${L?.source === 'file' ? '.LRC FILE' : 'LRCLIB'}`; el.badge.classList.add(L?.edited ? 'hand' : 'ok'); }
  else if (S.plain) { el.badge.textContent = 'TEXT ONLY · NOT SYNCED'; el.badge.classList.add('warn'); }
  else if (S.trackId) el.badge.textContent = S.status === 'error' ? 'OFFLINE?' : 'NO LYRICS';
  else el.badge.textContent = '';
  el.offset.hidden = !synced || S.mode === 'edit';
  el.offVal.textContent = `${S.offset >= 0 ? '+' : ''}${S.offset.toFixed(2)} s`;
  el.syncBtn.disabled = !S.trackId || S.mode === 'edit';
  el.searchBtn.disabled = !S.trackId;
  el.topBtn.classList.toggle('on', S.onTop);
  el.fullBtn.classList.toggle('on', S.full);
  // lyrics from a version of another length (radio edit vs extended mix): say so
  const md = L?.match?.duration, td = d?.duration;
  const off = S.mode === 'view' && synced && !L?.edited && md && td && Math.abs(md - td) > 8;
  el.note.hidden = !off;
  if (off) el.note.replaceChildren(`These lyrics come from a ${mmss(md)} version; this track lasts ${mmss(td)}. Shift them with − / + or sync them by hand.`,
    h('button', { onclick: () => enterEdit() }, 'SYNC'));
}

// ---- view -------------------------------------------------------------------------------------------
function renderBody() {
  el.view.hidden = S.mode !== 'view';
  el.edit.hidden = S.mode !== 'edit';
  if (S.mode !== 'view') return;
  const synced = S.lines.length > 0;
  el.lines.hidden = !synced;
  el.plain.hidden = synced || !S.plain;
  el.empty.hidden = synced || !!S.plain;
  if (synced) {
    el.lines.replaceChildren(...S.lines.map((l) => lineEl(l.text)));
  } else if (S.plain) {
    el.plain.textContent = S.plain;
  } else {
    const d = deckInfo();
    const msg = !S.trackId ? 'Load a track: its lyrics show here.'
      : S.status === 'loading' ? 'Looking for the lyrics…'
      : S.lyrics?.instrumental ? 'Instrumental'
      : S.status === 'error' ? `The lyrics could not be fetched (${S.error}).`
      : `No lyrics found for ${d?.title ?? 'this track'}.`;
    el.empty.replaceChildren(h('div', {}, msg), S.trackId && S.status !== 'loading' ? h('div.actions', {},
      h('button', { onclick: () => openSearch() }, 'SEARCH…'),
      h('button', { onclick: () => openPaste() }, 'PASTE LYRICS…'),
      h('button', { onclick: () => { S.status = 'loading'; renderBody(); post({ type: 'get', trackId: S.trackId, force: true }); } }, 'TRY AGAIN')) : '');
  }
}

function frame() {
  requestAnimationFrame(frame);
  if (S.mode === 'edit') { editFrame(); return; }
  const t = position();
  if (S.lines.length) {
    const i = lineAt(S.lines, t, S.offset);
    const rows = el.lines.children;
    if (i !== S.shownLine) {
      for (let k = 0; k < rows.length; k++) {
        rows[k].className = `ly-line${S.lines[k].text ? '' : ' gap'}${k === i ? ' now' : k < i ? ' past' : k <= i + 2 ? ' next' : ''}`;
      }
      S.shownLine = i;
      const target = rows[Math.max(0, i)] ?? rows[0];
      if (target) el.lines.style.transform = `translateY(${el.view.clientHeight / 2 - (target.offsetTop + target.offsetHeight / 2) + (i < 0 ? target.offsetHeight : 0)}px)`;
    }
    if (rows[i]) fillWords(rows[i], lineProgress(S.lines, i, t, S.offset));
  } else if (S.plain && !el.plain.hidden) {
    // not synced: scroll along with the track, roughly
    const d = deckInfo();
    if (d?.duration) el.plain.scrollTop = (t / d.duration) * (el.plain.scrollHeight - el.plain.clientHeight);
  }
}
requestAnimationFrame(frame);

/** A line as one span per word (spaces between), so the fill can go word by word across wrapped rows. */
function lineEl(text) {
  if (!text) return h('div.ly-line.gap', {}, '♪');
  const words = text.split(/\s+/).filter(Boolean);
  const row = h('div.ly-line', {});
  words.forEach((w, k) => { if (k) row.append(' '); row.append(h('span.w', {}, w)); });
  return row;
}

/** Karaoke fill: the line's progress spread over its words by their length, each word filled left to right. */
function fillWords(row, p) {
  const words = row.querySelectorAll('.w');
  if (!words.length) return;
  if (!row._len) row._len = [...words].map((w) => w.textContent.length);
  const total = row._len.reduce((a, b) => a + b, 0);
  let cut = p * total;
  words.forEach((w, k) => {
    const len = row._len[k];
    const local = Math.max(0, Math.min(1, cut / len));
    cut -= len;
    w.style.setProperty('--p', `${(local * 100).toFixed(1)}%`);
  });
}

let offsetSave = 0;
function shiftOffset(by) {
  if (!S.lines.length) return;
  S.offset = Math.round((S.offset + by) * 100) / 100;
  S.shownLine = -2;
  renderHead();
  clearTimeout(offsetSave);
  const id = S.trackId, lyrics = { ...S.lyrics, offset: S.offset };
  offsetSave = setTimeout(() => post({ type: 'save', trackId: id, lyrics }), 700);
}

function setSize(px) {
  S.size = Math.max(20, Math.min(120, px));
  store.set('size', S.size);
  document.documentElement.style.setProperty('--size', `${S.size}px`);
  S.shownLine = -2;
}

async function setWin(o) {
  const r = await window.rb?.lyrics?.window(o).catch(() => null);
  if (r) { S.onTop = r.onTop; S.full = r.fullscreen; el.root.classList.toggle('full', S.full); renderHead(); }
}
window.addEventListener('resize', () => { S.shownLine = -2; setWin({}); });
// full screen: the bar hides when the mouse rests
let idle = 0;
window.addEventListener('mousemove', () => { el.root.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => el.root.classList.add('idle'), 2500); });

// ---- manual sync ------------------------------------------------------------------------------------
function enterEdit(fromText = null) {
  if (!S.trackId) return;
  const lines = fromText !== null ? plainLines(fromText).filter((l) => l.text)
    : S.lines.length ? S.lines.map((l) => ({ t: Math.max(0, Math.round((l.t + S.offset) * 100) / 100), text: l.text }))
    : S.plain ? plainLines(S.plain).filter((l) => l.text) : [];
  if (!lines.length) lines.push({ t: null, text: '' });
  const firstUntimed = lines.findIndex((l) => l.t === null);
  S.edit = { deck: S.deck, trackId: S.trackId, lines, sel: firstUntimed >= 0 ? firstUntimed : 0, dirty: fromText !== null, rows: [] };
  S.mode = 'edit';
  buildEditor();
  renderBody(); renderHead();
}

function buildEditor() {
  const E = S.edit;
  const d = deckInfo(E.deck);
  el.pos = h('span.ed-pos');
  el.playBtn = h('button', { onclick: () => post({ type: 'play', deck: E.deck }) }, 'PLAY / PAUSE');
  el.tapBtn = h('button.tap', { title: 'Space', onclick: () => tap() }, 'TAP');
  el.list = h('div.ed-list');
  el.edit.replaceChildren(
    h('div.ed-help', {}, 'Play the track and tap ', h('kbd', {}, 'Space'), ' at the start of each line (the highlighted one). ',
      h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' pick a line · ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' 2 s back / on · ',
      h('kbd', {}, 'P'), ' play / pause · click a time to hear it again · ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'S'), ' save.',
      d ? h('span.dim', {}, `  Deck ${E.deck + 1}: ${d.title}`) : ''),
    h('div.ed-bar', {},
      h('button', { onclick: () => post({ type: 'nudge', deck: E.deck, by: -5 }) }, '−5 s'), el.playBtn,
      h('button', { onclick: () => post({ type: 'nudge', deck: E.deck, by: 5 }) }, '+5 s'), el.pos, el.tapBtn),
    el.list,
    h('div.ed-foot', {},
      h('span.dim', {}, 'Every line'),
      ...[-1, -0.1, 0.1, 1].map((by) => h('button', { onclick: () => shiftAll(by) }, `${by > 0 ? '+' : '−'}${Math.abs(by)} s`)),
      h('button', { onclick: () => openPaste(E.lines.map((l) => l.text).join('\n')) }, 'EDIT TEXT…'),
      h('button', { onclick: () => { E.lines.forEach((l) => { l.t = null; }); E.sel = 0; E.dirty = true; renderRows(); } }, 'CLEAR TIMES'),
      h('span.grow'),
      h('button', { onclick: () => leaveEdit() }, 'CANCEL'),
      h('button.primary', { onclick: () => saveEdit() }, 'SAVE')));
  renderRows();
}

function renderRows() {
  const E = S.edit;
  E.rows = E.lines.map((l, i) => {
    const tm = h(`button.tm${l.t === null ? '.none' : ''}`, { title: 'Pick this line; with a time: play from just before it', onclick: () => { E.sel = i; if (l.t !== null) post({ type: 'seek', deck: E.deck, t: l.t - 2 }); markSel(); } },
      l.t === null ? '--:--.--' : formatStamp(l.t));
    const input = h('input', { value: l.text, placeholder: '(instrumental)', oninput: (e) => { l.text = e.target.value; E.dirty = true; }, onfocus: () => { E.sel = i; markSel(); } });
    return h('div.ed-row', {},
      tm,
      h('button.sm', { title: '0.1 s sooner', onclick: () => adjust(i, -0.1) }, '−'),
      h('button.sm', { title: '0.1 s later', onclick: () => adjust(i, 0.1) }, '+'),
      input,
      h('button.sm', { title: 'Add a line after this one', onclick: () => { E.lines.splice(i + 1, 0, { t: null, text: '' }); E.dirty = true; renderRows(); } }, '＋'),
      h('button.sm', { title: 'Remove this line', onclick: () => { E.lines.splice(i, 1); if (!E.lines.length) E.lines.push({ t: null, text: '' }); E.sel = Math.min(E.sel, E.lines.length - 1); E.dirty = true; renderRows(); } }, '✕'));
  });
  el.list.replaceChildren(...E.rows);
  markSel();
}

function markSel() {
  const E = S.edit;
  E.rows.forEach((r, i) => r.classList.toggle('sel', i === E.sel));
  const row = E.rows[E.sel];
  if (row) {
    const top = row.offsetTop - el.list.offsetTop, h0 = el.list.clientHeight;
    if (top < el.list.scrollTop + 30 || top > el.list.scrollTop + h0 - 60) el.list.scrollTop = top - h0 / 3;
  }
}

function adjust(i, by) {
  const l = S.edit.lines[i];
  l.t = Math.max(0, Math.round(((l.t ?? position(S.edit.deck)) + by) * 100) / 100);
  S.edit.dirty = true;
  renderRows();
}

function shiftAll(by) {
  for (const l of S.edit.lines) if (l.t !== null) l.t = Math.max(0, Math.round((l.t + by) * 100) / 100);
  S.edit.dirty = true;
  renderRows();
}

/** SPACE: the highlighted line starts now; the next line gets highlighted. */
function tap() {
  const E = S.edit;
  if (!E) return;
  const l = E.lines[E.sel];
  if (!l) return;
  l.t = Math.round(position(E.deck) * 100) / 100;
  E.dirty = true;
  E.sel = Math.min(E.sel + 1, E.lines.length - 1);
  el.tapBtn.classList.add('hit'); setTimeout(() => el.tapBtn.classList.remove('hit'), 90);
  renderRows();
}

function editFrame() {
  const E = S.edit;
  if (!E || !el.pos) return;
  const d = deckInfo(E.deck);
  const t = position(E.deck);
  el.pos.textContent = `${formatStamp(t)} / ${d?.duration ? formatStamp(d.duration) : '--:--'}${d?.playing ? '  ▶' : '  ❚❚'}`;
  const timed = E.lines.map((l, i) => ({ t: l.t, i })).filter((x) => x.t !== null && x.t <= t);
  const nowRow = timed.length ? timed.reduce((a, b) => (b.t >= a.t ? b : a)).i : -1;
  E.rows.forEach((r, i) => r.classList.toggle('now', i === nowRow));
}

function saveEdit() {
  const E = S.edit;
  const timed = E.lines.filter((l) => l.t !== null).sort((a, b) => a.t - b.t);
  const plain = E.lines.map((l) => l.text).join('\n').trim();
  post({ type: 'save', trackId: E.trackId, lyrics: {
    source: S.lyrics?.source && S.lyrics.source !== 'manual' ? S.lyrics.source : 'manual',
    lrc: timed.length ? toLrc(timed) : null, plain: plain || null, offset: 0, edited: true, match: S.lyrics?.match ?? null,
  } });
  leaveEdit(true);
}

function leaveEdit(saved = false) {
  if (!saved && S.edit?.dirty && !confirm('Leave without saving the sync?')) return;
  S.mode = 'view'; S.edit = null; S.shownLine = -2;
  renderBody(); renderHead();
  pickDeck();
}

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (document.querySelector('.modal')) { if (e.key === 'Escape') document.querySelector('.modal')?.remove(); return; }
  if (S.mode === 'edit') {
    const E = S.edit;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEdit(); return; }
    if (e.key === 'Escape') { leaveEdit(); return; }
    if (typing) { if (e.key === 'Enter') e.target.blur(); return; }
    if (e.code === 'Space') { e.preventDefault(); tap(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); E.sel = Math.max(0, E.sel - 1); markSel(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); E.sel = Math.min(E.lines.length - 1, E.sel + 1); markSel(); }
    else if (e.key === 'ArrowLeft') post({ type: 'nudge', deck: E.deck, by: -2 });
    else if (e.key === 'ArrowRight') post({ type: 'nudge', deck: E.deck, by: 2 });
    else if (e.key.toLowerCase() === 'p') post({ type: 'play', deck: E.deck });
    return;
  }
  if (typing) return;
  if (e.key === '[') shiftOffset(e.shiftKey ? -1 : -0.1);
  else if (e.key === ']') shiftOffset(e.shiftKey ? 1 : 0.1);
  else if (e.key === '+' || e.key === '=') setSize(S.size + 4);
  else if (e.key === '-') setSize(S.size - 4);
});

// ---- search / paste ---------------------------------------------------------------------------------
function modal(...children) {
  const m = h('div.modal', { onclick: (e) => { if (e.target === m) m.remove(); } }, h('div.modal-box', {}, ...children));
  document.body.append(m);
  return m;
}

function openSearch() {
  const d = deckInfo();
  if (!S.trackId) return;
  const input = h('input', { value: `${mainArtist(d?.artist ?? '')} ${titleVariants(d?.title ?? '').at(-1) ?? ''}`.trim(), placeholder: 'Artist and title' });
  const results = h('div.results', {}, h('div.dim', {}, 'Search LRCLIB, then pick the right version (the closest length syncs best).'));
  const go = async () => {
    const id = Math.random().toString(36).slice(2);
    results.replaceChildren(h('div.dim', {}, 'Searching…'));
    const m = await new Promise((res) => { S.searches.set(id, res); post({ type: 'search', id, q: input.value }); setTimeout(() => res({ results: [], error: 'no answer' }), 20000); });
    if (m.error && !m.results?.length) { results.replaceChildren(h('div.dim', {}, `Search failed: ${m.error}`)); return; }
    if (!m.results.length) { results.replaceChildren(h('div.dim', {}, 'Nothing found. Paste the lyrics instead.')); return; }
    results.replaceChildren(...m.results.map((r) => h('button.result', {
      onclick: () => {
        post({ type: 'save', trackId: S.trackId, lyrics: { source: 'LRCLIB', lrc: r.synced, plain: r.plain, offset: 0, edited: true,
          match: { artist: r.artist, title: r.title, album: r.album, duration: r.duration, id: r.id } } });
        box.remove();
      },
    }, h('div', {}, h('div', {}, `${r.artist} — ${r.title}`), h('div.sub', {}, `${r.album || ''}${d?.duration ? `  ·  this track ${mmss(d.duration)}` : ''}`)),
    h('span.dim', {}, r.duration ? mmss(r.duration) : ''), h(`span.badge${r.synced ? '.ok' : '.warn'}`, {}, r.synced ? 'SYNCED' : 'TEXT'))));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const box = modal(h('h3', {}, 'Find lyrics'), h('div.modal-row', {}, input, h('button.primary', { onclick: go }, 'SEARCH')), results,
    h('div.foot', {}, h('button', { onclick: () => { box.remove(); openPaste(); } }, 'PASTE LYRICS…'),
      h('button', { onclick: () => { box.remove(); S.status = 'loading'; renderBody(); renderHead(); post({ type: 'get', trackId: S.trackId, force: true }); } }, 'AUTOMATIC SEARCH AGAIN'),
      h('button', { onclick: () => box.remove() }, 'CLOSE')));
  input.focus(); input.select();
  go();
}

/** Paste or edit the text; the lines keep their times by position, then sync the rest by hand. */
function openPaste(text = '') {
  const area = h('textarea', { placeholder: 'One line of lyrics per line', value: text });
  area.value = text;
  const box = modal(h('h3', {}, text ? 'Edit the text' : 'Paste the lyrics'), area,
    h('div.foot', {}, h('button', { onclick: () => box.remove() }, 'CANCEL'),
      h('button.primary', { onclick: () => {
        box.remove();
        if (S.mode === 'edit') {
          const old = S.edit.lines;
          S.edit.lines = plainLines(area.value).filter((l) => l.text).map((l, i) => ({ t: old[i]?.t ?? null, text: l.text }));
          if (!S.edit.lines.length) S.edit.lines.push({ t: null, text: '' });
          S.edit.sel = Math.max(0, S.edit.lines.findIndex((l) => l.t === null));
          S.edit.dirty = true;
          renderRows();
        } else enterEdit(area.value);
      } }, 'OK')));
  area.focus();
}
