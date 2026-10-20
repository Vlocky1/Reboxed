import { h, knob, contextMenu } from './dom.js';
import { SAMPLER_SLOTS } from '../audio/sampler.js';

export class SamplerView {
  /**
   * @param {import('../audio/sampler.js').Sampler} sampler
   * @param {{loadSamplerSlot: (i: number, trackId: string) => void}} app
   */
  constructor(sampler, app) {
    this.sampler = sampler;
    this.app = app;
    this.tiles = Array.from({ length: SAMPLER_SLOTS }, (_, i) => {
      const name = h('div.smp-name');
      const bar = h('div.smp-bar');
      const info = h('div.smp-info');
      // Loaded slot: save / edit / eject buttons (they do not trigger the sample).
      const act = (label, title, fn) => {
        const b = h('button.smp-act', { type: 'button', title }, label);
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
      };
      const actions = h('div.smp-actions', {},
        act('⤓', 'Save as WAV…', () => app.saveSample(i)),
        act('✎', 'Edit (trim, mode, sync, gain)…', () => app.editSample(i)),
        act('⏏', 'Eject', () => app.ejectSample(i)));
      const tile = h('div.smp-tile', { title: 'Empty slot: click to capture the loop playing now · loaded: click to play / stop · drop a track to load · right-click: options' },
        h('div.smp-num', {}, String(i + 1)), name, info, actions, h('div.smp-prog', {}, bar));
      tile.addEventListener('pointerdown', (e) => { if (e.button === 0) app.samplerPress(i); });
      tile.addEventListener('contextmenu', (e) => { e.preventDefault(); this.menu(e, i); });
      tile.addEventListener('wheel', (e) => {
        e.preventDefault();
        const s = sampler.slots[i];
        sampler.update(i, { gain: Math.max(0, Math.min(2, s.gain - Math.sign(e.deltaY) * 0.05)) });
      }, { passive: false });
      tile.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-rb-tracks')) { e.preventDefault(); tile.classList.add('drop'); } });
      tile.addEventListener('dragleave', () => tile.classList.remove('drop'));
      tile.addEventListener('drop', (e) => {
        tile.classList.remove('drop');
        const [id] = JSON.parse(e.dataTransfer.getData('application/x-rb-tracks') || '[]');
        if (id) app.loadSamplerSlot(i, id);
      });
      return { tile, name, bar, info };
    });
    this.el = h('section.sampler', {},
      h('div.smp-side', {},
        h('div.fx-title', {}, 'SAMPLER'),
        knob({ label: 'VOLUME', min: 0, max: 1.2, value: 0.8, reset: 0.8, size: 'sm', onInput: (v) => sampler.setVolume(v) }),
        h('button.dbtn.small', { onclick: () => sampler.stopAll() }, 'STOP ALL')),
      h('div.smp-grid', {}, this.tiles.map((t) => t.tile)));
    sampler.addEventListener('change', () => this.refresh());
    this.refresh();
  }

  menu(e, i) {
    const s = this.sampler.slots[i];
    contextMenu(e.clientX, e.clientY, [
      { label: 'One shot', checked: s.mode === 'oneshot', action: () => this.sampler.update(i, { mode: 'oneshot' }) },
      { label: 'Loop', checked: s.mode === 'loop', action: () => this.sampler.update(i, { mode: 'loop' }) },
      { label: 'Sync to master tempo', checked: s.sync, action: () => this.sampler.update(i, { sync: !s.sync }) },
      { label: 'Gain', submenu: [0.5, 0.75, 1, 1.25, 1.5].map((g) => ({ label: `${Math.round(g * 100)}%`, checked: Math.abs(s.gain - g) < 0.01, action: () => this.sampler.update(i, { gain: g }) })) },
      '-',
      { label: 'Capture the playing loop here', disabled: !!s.buffer, action: () => this.app.samplerPress(i) },
      { label: 'Save as WAV…', disabled: !s.buffer, action: () => this.app.saveSample(i) },
      { label: 'Edit…', disabled: !s.buffer, action: () => this.app.editSample(i) },
      { label: 'Eject', disabled: !s.buffer, action: () => this.app.ejectSample(i) },
    ]);
  }

  refresh() {
    this.tiles.forEach((t, i) => {
      const s = this.sampler.slots[i];
      t.name.textContent = s.name || 'click: capture loop';
      t.info.textContent = s.buffer ? `${s.mode === 'loop' ? 'LOOP' : '1SHOT'}${s.sync && s.bpm ? ` · ${s.bpm.toFixed(1)}` : ''}${s.gain !== 1 ? ` · ${Math.round(s.gain * 100)}%` : ''}` : '';
      t.tile.classList.toggle('loaded', !!s.buffer);
      t.tile.classList.toggle('loop', s.mode === 'loop');
      t.tile.classList.toggle('playing', this.sampler.isPlaying(i));
    });
  }

  frame() {
    this.tiles.forEach((t, i) => {
      t.bar.style.width = `${this.sampler.progress(i) * 100}%`;
    });
  }
}
