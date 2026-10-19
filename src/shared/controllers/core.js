// Controller engine core (no DOM): routes MIDI input to named functions using a parsed rekordbox
// mapping, and sends LED/indicator output for named functions.
//
// Control types (rekordbox mapping "type" column):
//   Button / Pad / JogTouch : note on (vel > 0) = press, note off / vel 0 = release
//   KnobSliderHiRes         : 14-bit CC, MSB on data1, LSB on data1 + 0x20
//   Rotary                  : relative encoder, 1..63 = +n, 65..127 = -(128 - n)
//   JogRotate / Difference  : relative jog centred on 64 (65 = +1, 63 = -1)
import { addrKey } from './rbcsv.js';

/**
 * @typedef {{name: string, deck: number|null, press?: boolean, value?: number, value01?: number, delta?: number, raw: number[]}} ControlEvent
 */

export class ControllerCore {
  /**
   * @param {{entries: import('./rbcsv.js').MappingEntry[]}} profile
   * @param {(ev: ControlEvent) => void} dispatch
   * @param {(bytes: number[]) => void} send  MIDI output
   */
  constructor(profile, dispatch, send) {
    this.dispatch = dispatch;
    this.send = send;
    this.routes = new Map();     // addrKey -> [{entry, addr, part}]
    this.outputs = new Map();    // `${name}|${deck}` -> [addr]
    this.msb = new Map();        // hi-res MSB cache by addrKey of the MSB
    this.ledCache = new Map();   // `${status}:${data1}` -> last value sent
    for (const entry of profile.entries) {
      for (const addr of entry.inputs) {
        this.route(addrKey(addr.status, addr.data1), { entry, addr, part: 'main' });
        if (entry.type === 'KnobSliderHiRes') this.route(addrKey(addr.status, addr.data1 + 0x20), { entry, addr, part: 'lsb' });
      }
      for (const addr of entry.outputs) {
        const k = `${entry.name}|${addr.deck}`;
        if (!this.outputs.has(k)) this.outputs.set(k, []);
        this.outputs.get(k).push(addr);
      }
    }
  }

  route(key, r) {
    if (!this.routes.has(key)) this.routes.set(key, []);
    this.routes.get(key).push(r);
  }

  /** Handle one incoming MIDI message. Returns the events dispatched (for monitors/tests). */
  receive(bytes) {
    const [status, d1 = 0, d2 = 0] = bytes;
    const type = status & 0xf0;
    if (type !== 0x80 && type !== 0x90 && type !== 0xb0) return [];
    const routes = this.routes.get(addrKey(status, d1));
    if (!routes) return [];
    const events = [];
    for (const { entry, addr, part } of routes) {
      const ev = { name: entry.name, deck: addr.deck, raw: bytes };
      switch (entry.type) {
        case 'KnobSliderHiRes': {
          const msbKey = addrKey(addr.status, addr.data1);
          if (part === 'main') {
            this.msb.set(msbKey, d2);
            ev.value = d2 << 7;
          } else {
            ev.value = ((this.msb.get(msbKey) ?? 0) << 7) | d2;
          }
          ev.value01 = ev.value / 16383;
          break;
        }
        case 'Rotary':
          ev.delta = d2 === 0 || d2 === 64 ? 0 : d2 < 64 ? d2 : d2 - 128;
          break;
        case 'JogRotate':
        case 'Difference':
          ev.delta = d2 - 64;
          break;
        default: // Button, Pad, JogTouch, Value...
          ev.press = type === 0x90 && d2 > 0;
          ev.value = d2;
      }
      events.push(ev);
      this.dispatch(ev);
    }
    return events;
  }

  /**
   * Set an output (LED / indicator) for a mapped function. value: boolean or 0..127.
   * Only changed values are sent unless force is true.
   */
  output(name, deck, value, force = false) {
    const addrs = this.outputs.get(`${name}|${deck ?? null}`);
    if (!addrs) return false;
    const v = value === true ? 0x7f : value === false ? 0 : Math.max(0, Math.min(127, Math.round(value)));
    for (const a of addrs) {
      const k = `${a.status}:${a.data1}`;
      if (!force && this.ledCache.get(k) === v) continue;
      this.ledCache.set(k, v);
      this.send([a.status, a.data1, v]);
    }
    return true;
  }

  /** LED by raw address (functions whose mapping rows carry no deck, e.g. FX PART SELECT). */
  sendRaw(status, data1, value, force = false) {
    const v = value === true ? 0x7f : value === false ? 0 : Math.max(0, Math.min(127, Math.round(value)));
    const k = `${status}:${data1}`;
    if (!force && this.ledCache.get(k) === v) return;
    this.ledCache.set(k, v);
    this.send([status, data1, v]);
  }

  hasOutput(name, deck) { return this.outputs.has(`${name}|${deck ?? null}`); }

  /** Forget LED state so the next update resends everything (e.g. after reconnect). */
  resetOutputs() { this.ledCache.clear(); }
}
