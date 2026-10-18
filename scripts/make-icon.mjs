// Draws the Reboxed icon (jog wheel + "R") with Electron's canvas and writes build/icon.png (512 px)
// and build/icon.ico (16-256 px, PNG-compressed entries). Run: npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const draw = `(${(sizes) => {
  const render = (s) => {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    const k = s / 256;
    // Rounded square, dark with a blue glow at the top.
    const r = 56 * k;
    g.beginPath();
    g.moveTo(r, 0); g.arcTo(s, 0, s, s, r); g.arcTo(s, s, 0, s, r); g.arcTo(0, s, 0, 0, r); g.arcTo(0, 0, s, 0, r);
    const bg = g.createLinearGradient(0, 0, 0, s);
    bg.addColorStop(0, '#1d2633'); bg.addColorStop(1, '#0b0d11');
    g.fillStyle = bg; g.fill();
    const cx = s / 2; const cy = s / 2;
    // Platter with grooves.
    g.beginPath(); g.arc(cx, cy, 96 * k, 0, Math.PI * 2); g.fillStyle = '#05070a'; g.fill();
    if (s >= 48) {
      g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = Math.max(1, 1.2 * k);
      for (let rr = 52; rr < 92; rr += 7) { g.beginPath(); g.arc(cx, cy, rr * k, 0, Math.PI * 2); g.stroke(); }
    }
    // Blue jog ring (270 degrees, like a deck's position indicator).
    g.lineCap = 'round';
    g.lineWidth = 14 * k;
    const ring = g.createLinearGradient(0, 0, s, s);
    ring.addColorStop(0, '#3d8dff'); ring.addColorStop(1, '#1473eb');
    g.strokeStyle = ring;
    g.beginPath(); g.arc(cx, cy, 100 * k, -Math.PI * 0.5, Math.PI * 1.0); g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(cx + 100 * k * Math.cos(Math.PI), cy + 100 * k * Math.sin(Math.PI), 9 * k, 0, Math.PI * 2); g.fill();
    // Label with the R.
    g.beginPath(); g.arc(cx, cy, 46 * k, 0, Math.PI * 2); g.fillStyle = '#1473eb'; g.fill();
    g.fillStyle = '#ffffff';
    g.font = `800 ${62 * k}px "Segoe UI", Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('R', cx + 1 * k, cy + 3 * k);
    return c.toDataURL('image/png');
  };
  return { big: render(512), sizes: sizes.map(render) };
}})(${JSON.stringify(SIZES)})`;

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
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const { big, sizes } = await win.webContents.executeJavaScript(draw);
  const png = (url) => Buffer.from(url.split(',')[1], 'base64');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'icon.png'), png(big));
  await writeFile(join(out, 'icon.ico'), ico(sizes.map(png), SIZES));
  console.log('icon written to', out);
  app.quit();
});
