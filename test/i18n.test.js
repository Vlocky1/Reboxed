// French interface: choice of the language, templates and their values, every wrapped text translated,
// placeholders and outer spaces kept, errors of the main process translated whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { pickLang, templateKey, translateMessage, translator, tx } from '../src/shared/i18n.js';
import { FR } from '../src/shared/lang/fr.js';

test('language: the saved choice, else Windows; the smoke test stays in English unless asked', () => {
  assert.equal(pickLang({ system: 'fr-FR' }), 'fr');
  assert.equal(pickLang({ system: 'fr' }), 'fr');
  assert.equal(pickLang({ system: 'en-US' }), 'en');
  assert.equal(pickLang({ system: 'de-DE' }), 'en');
  assert.equal(pickLang({ choice: 'en', system: 'fr-FR' }), 'en');
  assert.equal(pickLang({ choice: 'fr', system: 'en-US' }), 'fr');
  assert.equal(pickLang({ choice: 'fr', system: 'fr-FR', search: '?smoke=1' }), 'en');
  assert.equal(pickLang({ system: 'en-US', search: '?smoke=1&lang=fr' }), 'fr');
});

test('translator: plain texts, templates with values (also reordered), unknown texts unchanged', () => {
  const fr = translator({ Save: 'Enregistrer', 'Load to Deck {0}': 'Charger sur le deck {0}', '{0} of {1}': '{1} / {0}' });
  assert.equal(fr('Save'), 'Enregistrer');
  assert.equal(fr('Unknown'), 'Unknown');
  assert.equal(fr`Load to Deck ${2}`, 'Charger sur le deck 2');
  assert.equal(fr`${1} of ${9}`, '9 / 1');
  assert.equal(fr`No entry ${'{0} $&'}`, 'No entry {0} $&', 'values are never read as placeholders');
  assert.equal(translator(null)`Deck ${3}`, 'Deck 3');
  assert.equal(templateKey(((s) => s)`a ${1} b ${2}`), 'a {0} b {1}');
  assert.equal(tx('Save'), 'Save', 'no page: English');
});

test('every text wrapped with tx(\'…\') has a French entry', () => {
  const missing = [];
  for (const d of ['src/renderer', 'src/renderer/ui', 'src/shared']) {
    for (const f of readdirSync(d).filter((n) => n.endsWith('.js') && n !== 'i18n.js')) {
      for (const m of readFileSync(`${d}/${f}`, 'utf8').matchAll(/\btx\((?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")\)/g)) {
        const text = (m[1] ?? m[2]).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
        if (FR[text] === undefined) missing.push(`${f}: ${text}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('French entries: no unknown placeholder, outer spaces kept, the other software never named', () => {
  for (const [en, fr] of Object.entries(FR)) {
    for (const p of fr.match(/\{\d+\}/g) ?? []) assert.ok(en.includes(p), `${en} -> ${fr}`);
    assert.equal(/^\s*/.exec(fr)[0], /^\s*/.exec(en)[0], en);
    assert.equal(/\s*$/.exec(fr)[0], /\s*$/.exec(en)[0], en);
    assert.ok(!/rekordbox|\bCDJ\b/i.test(fr), fr);
  }
});

test('messages of the main process: exact, with values, unknown left as they are', () => {
  assert.equal(translateMessage('Spotify: access refused', FR), 'Spotify : accès refusé');
  assert.equal(translateMessage('Spotify sign-in failed (invalid_client)', FR), 'Connexion Spotify échouée (invalid_client)');
  assert.equal(translateMessage('Something else entirely', FR), 'Something else entirely');
  assert.equal(translateMessage('Spotify: access refused', null), 'Spotify: access refused');
});
