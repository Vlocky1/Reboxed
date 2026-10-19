// Renders the Reboxed logo (src/renderer/assets/logo.svg) with Electron's canvas and writes
// build/icon.png (512 px) and build/icon.ico (16-256 px, PNG entries). Run: npm run icon
import { app, BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** ICO container with PNG entries (supported since Windows Vista). */
function ico(pngs, sizes) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach((p, i) => {
    const e = 6 + 16 * i;
    const s = sizes[i] >= 256 ? 0 : sizes[i];
    head.writeUInt8(s, e); head.writeUInt8(s, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(p.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += p.length;
  });
  return Buffer.concat([head, ...pngs]);
}

app.whenReady().then(async () => {
  const svg = await readFile(join(root, 'src/renderer/assets/logo.svg'), 'utf8');
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const { big, sizes } = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(url)};
    await img.decode();
    const render = (s) => {
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, s, s);
      return c.toDataURL('image/png');
    };
    return { big: render(512), sizes: ${JSON.stringify(SIZES)}.map(render) };
  })()`);
  const png = (u) => Buffer.from(u.split(',')[1], 'base64');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'icon.png'), png(big));
  await writeFile(join(out, 'icon.ico'), ico(sizes.map(png), SIZES));
  console.log('icon written to', out);
  app.quit();
});
