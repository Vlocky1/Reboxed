// Preferences > Plugins: hardware plugins (built-in and installed), enable/disable, install, create
// from a rekordbox controller mapping, remove. Format: docs/PLUGINS.md.
import { h, modal, toast } from './dom.js';

export async function pluginsSection(app) {
  const reg = app.plugins;
  const list = h('div.plugin-list');
  const connected = () => new Set([...(app.midi?.controllers?.values() ?? [])].map((d) => d.plugin?.id).filter(Boolean));

  const changed = async () => { await reg.refresh(); await app.midi?.reattach(); render(); };

  const render = () => {
    const live = connected();
    list.replaceChildren(...reg.all.map((p) => {
      const problem = reg.problem(p);
      const toggle = h('input', { type: 'checkbox', checked: reg.isEnabled(p), disabled: !!problem,
        onchange: async (e) => { reg.setEnabled(p.id, e.target.checked); await app.midi?.reattach(); render(); } });
      return h('div.plugin-card', { class: problem ? 'bad' : undefined },
        h('label.plugin-head', {}, toggle,
          h('b', {}, p.name ?? p.id), h('span.dim', {}, ` ${p.version ?? ''}`),
          p.builtin ? h('span.plugin-tag', {}, 'built in') : h('span.plugin-tag.user', {}, p.overrides ? 'installed · replaces built in' : 'installed'),
          live.has(p.id) ? h('span.plugin-tag.live', {}, '● connected') : null),
        h('div.dim', {}, p.description ?? ''),
        h('div.plugin-meta', {},
          h('span', {}, `MIDI port: ${(p.match ?? []).join(', ') || '—'}`),
          p.decks ? h('span', {}, `${p.decks} decks`) : null,
          p.audio?.device ? h('span', {}, `sound card: ${p.audio.device} (${p.audio.layout ?? 'stereo'})`) : null,
          p.author ? h('span', {}, `by ${p.author}`) : null),
        problem ? h('div.plugin-error', {}, `⚠ ${problem}`) : null,
        p.builtin ? null : h('button.dbtn.small', { onclick: async () => {
          const ok = await modal('Remove plugin', h('p', {}, `Remove ${p.name ?? p.id}?`), [{ label: 'Remove', value: true, primary: true }, { label: 'Cancel', value: false }]);
          if (!ok) return;
          await window.rb.plugins.remove(p.id); toast(`${p.name ?? p.id} removed`); await changed();
        } }, 'Remove'));
    }));
  };

  const install = async () => {
    const [dir] = await window.rb.openFolder();
    if (!dir) return;
    try { const m = await window.rb.plugins.install(dir); toast(`${m.name ?? m.id} installed`); await changed(); }
    catch (err) { toast(`Install failed: ${err.message}`, 6000); }
  };

  const fromCsv = async () => {
    const [csv] = await window.rb.openFiles('csv');
    if (!csv) return;
    const name = h('input', { type: 'text', placeholder: 'e.g. Pioneer DDJ-400' });
    const match = h('input', { type: 'text', placeholder: 'part of the MIDI port name, e.g. DDJ-400' });
    const decks = h('select', {}, h('option', { value: 2 }, '2 decks'), h('option', { value: 4 }, '4 decks'));
    const ok = await modal('New plugin from a controller mapping (CSV)', h('div.form-grid', {},
      h('label', {}, 'Mapping'), h('code.path', { title: csv }, csv),
      h('label', {}, 'Name'), name, h('label', {}, 'MIDI port name'), match, h('label', {}, 'Decks'), decks,
      h('label', {}, ''), h('span.dim', {}, 'Empty fields: taken from the mapping file (a .midi.csv from the MidiMappings folder of your DJ software).')),
    [{ label: 'Create', value: true, primary: true }, { label: 'Cancel', value: false }]);
    if (!ok) return;
    try {
      const m = await window.rb.plugins.createFromCsv(csv, { name: name.value.trim() || undefined, match: match.value.trim() || undefined, decks: Number(decks.value) });
      toast(`Plugin ${m.name} created`); await changed();
    } catch (err) { toast(`Could not create the plugin: ${err.message}`, 6000); }
  };

  // Mods: changes a controller plugin offers for part of the hardware, turned on per controller.
  const modsBox = h('div.plugin-list.mods-list');
  const renderMods = () => {
    const live = connected();
    const withMods = reg.all.filter((p) => !reg.problem(p) && reg.modsOf(p).length);
    modsBox.replaceChildren(...(withMods.length ? withMods.map((p) => {
      const on = new Set(reg.enabledModIds(p));
      return h('div.plugin-card', {},
        h('div.plugin-head', {}, h('b', {}, p.name ?? p.id), live.has(p.id) ? h('span.plugin-tag.live', {}, '● connected') : null),
        ...reg.modsOf(p).map((m) => h('label.mod-row', {},
          h('input', { type: 'checkbox', checked: on.has(m.id), onchange: (e) => { reg.setModEnabled(p, m.id, e.target.checked); toast(`${m.name ?? m.id}: ${e.target.checked ? 'on' : 'off'}`, 1500); renderMods(); } }),
          h('span', {}, h('b', {}, m.name ?? m.id), h('div.dim', {}, m.description ?? '')))));
    }) : [h('p.dim', {}, 'No controller plugin offers mods yet.')]));
  };

  await reg.refresh();
  render();
  renderMods();
  // two columns side by side: Mods | Plugins
  return h('div.mods-plugins', {},
    h('section.mp-col', {},
      h('h3.settings-sub', {}, 'Mods'),
      h('p.dim', {}, 'A mod changes what part of a controller does, e.g. stem buttons on pads that had effects. They apply at once, the controller can stay connected.'),
      modsBox),
    h('section.mp-col', {},
      h('h3.settings-sub', {}, 'Plugins'),
      h('p.dim', {}, 'A plugin teaches Reboxed a piece of hardware: which MIDI messages its buttons send, its LEDs and its sound card. Anyone can write one for a controller that is not supported yet — see docs/PLUGINS.md in the Reboxed repository.'),
      h('div.frow', {},
        h('button.dbtn.small', { onclick: install }, 'Install a plugin folder…'),
        h('button.dbtn.small', { onclick: fromCsv }, 'Create from a controller mapping (CSV)…'),
        h('button.dbtn.small', { onclick: () => window.rb.plugins.openFolder() }, 'Open the plugins folder'),
        h('button.dbtn.small', { onclick: changed }, 'Reload')),
      list));
}
