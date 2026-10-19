// Build a Reboxed controller plugin from a rekordbox controller mapping (MidiMappings/<model>.midi.csv).
// Usage: node scripts/plugin-from-rekordbox.mjs <mapping.csv> <output folder> --id <id> --name "<name>"
//          [--match "<port name part>"] [--decks 2|4] [--audio "<sound card name part>" --layout quad]
// The plugin gets plugin.json (manifest) and mapping.json (the parsed mapping in Reboxed's format).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRekordboxMapping } from '../src/shared/controllers/rbcsv.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const [csv, out] = args;
if (!csv || !out || !opt('id')) {
  console.error('usage: node scripts/plugin-from-rekordbox.mjs <mapping.csv> <output folder> --id <id> --name "<name>" [--match ...] [--decks 2|4]');
  process.exit(1);
}
const mapping = parseRekordboxMapping(await readFile(csv, 'utf8'));
const manifest = {
  id: opt('id'),
  name: opt('name', mapping.device),
  version: opt('version', '1.0.0'),
  author: opt('author', 'Reboxed'),
  kind: 'controller',
  description: opt('description', `${mapping.device}: generated from its rekordbox mapping (${mapping.entries.length} entries).`),
  match: [opt('match', mapping.device)],
  driver: 'pioneer',
  mapping: 'mapping.json',
  decks: Number(opt('decks', '2')),
  ...(opt('audio') ? { audio: { device: opt('audio'), layout: opt('layout', 'stereo') } } : {}),
};
await mkdir(out, { recursive: true });
await writeFile(join(out, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(out, 'mapping.json'), JSON.stringify(mapping));
console.log(`${manifest.name}: ${mapping.entries.length} entries -> ${out}`);
