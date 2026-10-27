// Optional language model for track suggestions (Google Gemini, the user's own API key).
// The key is kept in the main process (userData/ai.json) and never sent back to the page. Only the
// prompt text built by shared/suggest-ai.js leaves the computer: titles, artists, BPM, keys, genres.
import { readFile, writeFile } from 'node:fs/promises';

export const DEFAULT_MODEL = 'gemini-flash-latest';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class AiClient {
  /**
   * @param {string} file settings file (JSON: {geminiKey, model})
   * @param {(url: string, init?: object) => Promise<Response>} fetch
   */
  constructor(file, fetch, crypt = null) {
    this.file = file;
    this.fetch = fetch;
    this.crypt = crypt; // {encrypt(text) -> base64 | null, decrypt(base64) -> text}: the key is stored encrypted
    this.cfg = null;
  }

  async load() {
    if (!this.cfg) {
      const disk = JSON.parse(await readFile(this.file, 'utf8').catch(() => '{}'));
      let key = disk.geminiKey;
      if (disk.geminiKeyEnc && this.crypt) { try { key = this.crypt.decrypt(disk.geminiKeyEnc); } catch { key = undefined; } }
      this.cfg = { geminiKey: key || undefined, model: disk.model };
    }
    return this.cfg;
  }

  async save() {
    const c = this.cfg;
    const enc = c.geminiKey && this.crypt ? this.crypt.encrypt(c.geminiKey) : null;
    await writeFile(this.file, JSON.stringify({ model: c.model, ...(enc ? { geminiKeyEnc: enc } : { geminiKey: c.geminiKey }) }));
  }

  /** What the page may know: is a key set, which model. */
  async status() {
    const c = await this.load();
    return { hasKey: !!c.geminiKey, model: c.model || DEFAULT_MODEL, keyHint: c.geminiKey ? `…${c.geminiKey.slice(-4)}` : '' };
  }

  async configure({ key, model } = {}) {
    const c = await this.load();
    if (key !== undefined) {
      const k = String(key).trim();
      if (k && !/^[A-Za-z0-9_-]{20,100}$/.test(k)) throw new Error('This does not look like a Gemini API key');
      c.geminiKey = k || undefined;
    }
    if (model !== undefined) {
      const m = String(model).trim();
      if (m && !/^[a-z0-9.-]{3,60}$/.test(m)) throw new Error('Invalid model name');
      c.model = m || undefined;
    }
    await this.save();
    return this.status();
  }

  /** Send a prompt, return the model's text answer. */
  async ask(prompt) {
    const c = await this.load();
    if (!c.geminiKey) throw new Error('No Gemini API key (Preferences > Library > Track suggestion)');
    if (typeof prompt !== 'string' || prompt.length > 60000) throw new Error('prompt too long');
    const res = await this.fetch(`${ENDPOINT}/${encodeURIComponent(c.model || DEFAULT_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.geminiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.6 },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message ? `Gemini: ${data.error.message}` : `Gemini: HTTP ${res.status}`);
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text) throw new Error('Gemini gave no answer');
    return text;
  }
}
