// Keyboard shortcuts modelled on Rekordbox's "Performance 1" preset (deck 1 / deck 2 keys).
// Keys are matched on KeyboardEvent.code so they work on AZERTY and QWERTY alike.

const BEAT_LOOPS = [0.5, 1, 2, 4, 8];

/** [code, shift, ctrl] -> handler. Built per deck from a key table. */
const DECK_KEYS = [
  { play: 'KeyZ', cue: 'KeyA', sync: 'KeyQ', bendUp: 'KeyE', bendDown: 'KeyW', loopIn: 'KeyD', loopOut: 'KeyF', exit: 'KeyG',
    slipRev: 'KeyS', memSet: 'KeyT', memDel: 'KeyR', loops: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'] },
  { play: 'KeyN', cue: 'KeyH', sync: 'KeyY', bendUp: 'KeyI', bendDown: 'KeyU', loopIn: 'KeyK', loopOut: 'KeyL', exit: 'Semicolon',
    slipRev: 'KeyJ', memSet: 'KeyP', memDel: 'KeyO', loops: ['Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'] },
];

export const SHORTCUT_HELP = [
  ['Full screen on / off', 'F11', ''],
  ['Play / Pause', 'Z', 'N'], ['Cue (hold to preview)', 'A', 'H'], ['Beat sync', 'Q', 'Y'],
  ['Pitch bend − / +', 'W / E', 'U / I'], ['Loop in / out / exit', 'D / F / G', 'K / L / ;'],
  ['Loop ½ / ×2', 'Shift+D / Shift+G', 'Shift+K / Shift+;'], ['Beat loop ½,1,2,4,8', 'Ctrl+1…5', 'Ctrl+6…0'],
  ['Hot cue A–D (Shift = delete)', '1…4', '6…9'], ['Slip reverse (hold)', 'S', 'J'],
  ['Memory cue set / delete', 'Shift+T / Shift+R', 'Shift+P / Shift+O'],
  ['Load selected track', 'Shift+←', 'Shift+→'], ['Search', 'Ctrl+F', ''], ['Browser full / split', 'Space', ''],
];

/**
 * @param {object} app {engine, browser, loadTrack, toggleLayout}
 */
export function installKeyboard(app) {
  const held = new Set();

  const isTyping = (e) => {
    const t = e.target;
    return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable;
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); app.browser.focusSearch(); return; }
    if (isTyping(e) || document.querySelector('.overlay')) return;
    if (e.repeat && !['KeyE', 'KeyW', 'KeyI', 'KeyU'].includes(e.code)) { e.preventDefault(); return; }

    if (e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      const id = app.browser.currentTrackId();
      if (id) app.loadTrack(e.code === 'ArrowLeft' ? 0 : 1, id);
      e.preventDefault();
      return;
    }
    if (e.code === 'Space' && !e.ctrlKey) { app.toggleLayout(); e.preventDefault(); return; }

    for (let i = 0; i < DECK_KEYS.length; i++) {
      const k = DECK_KEYS[i];
      const d = app.engine.decks[i];
      if (!d) continue;
      const handled = (() => {
        if (e.ctrlKey) {
          const li = k.loops.indexOf(e.code);
          if (li >= 0) { d.beatLoop(BEAT_LOOPS[li]); return true; }
          return false;
        }
        // Hot cues A-D: 1..4 for deck 1, 6..9 for deck 2
        const hot = (i === 0 ? ['Digit1', 'Digit2', 'Digit3', 'Digit4'] : ['Digit6', 'Digit7', 'Digit8', 'Digit9']).indexOf(e.code);
        if (hot >= 0) { if (e.shiftKey) d.deleteHotCue(hot); else d.hotCuePress(hot); return true; }
        switch (e.code) {
          case k.play: d.playPause(); return true;
          case k.cue: if (!held.has(e.code)) { held.add(e.code); d.cueDown(); } return true;
          case k.sync: d.toggleSync(); return true;
          case k.bendUp: d.nudge(1); held.add(e.code); return true;
          case k.bendDown: d.nudge(-1); held.add(e.code); return true;
          case k.loopIn: if (e.shiftKey) d.resizeLoop(0.5); else d.loopIn(); return true;
          case k.loopOut: d.loopOut(); return true;
          case k.exit: if (e.shiftKey) d.resizeLoop(2); else d.reloopExit(); return true;
          case k.slipRev:
            if (!held.has(e.code)) { held.add(e.code); if (!d.slip) { d.toggleSlip(); d.autoSlip = true; } d.setReverse(true); }
            return true;
          case k.memSet: if (e.shiftKey) { d.addMemoryCue(); return true; } return false;
          case k.memDel: if (e.shiftKey) { d.deleteMemoryCueNear(); return true; } return false;
          default: return false;
        }
      })();
      if (handled) { e.preventDefault(); return; }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (!held.has(e.code)) return;
    held.delete(e.code);
    for (let i = 0; i < DECK_KEYS.length; i++) {
      const k = DECK_KEYS[i];
      const d = app.engine.decks[i];
      if (!d) continue;
      if (e.code === k.cue) d.cueUp();
      if (e.code === k.bendUp || e.code === k.bendDown) d.nudge(0);
      if (e.code === k.slipRev) { d.setReverse(false); if (d.autoSlip) { d.autoSlip = false; d.toggleSlip(); } }
    }
  });
}
