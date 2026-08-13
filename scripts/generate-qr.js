import QRCode from 'qrcode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrDestinations } from '../qr-routing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const arg = process.argv.find(v => v.startsWith('--base-url='));
const baseUrl = (arg ? arg.split('=').slice(1).join('=') : process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
  console.error('Provide PUBLIC_BASE_URL or --base-url=https://your-real-domain.example');
  process.exit(1);
}
const out = path.join(root, 'qr');
await fs.mkdir(out, { recursive: true });
for (const destination of qrDestinations(baseUrl)) {
  await QRCode.toFile(path.join(out, `${destination.slug}.png`), destination.url, { width: 1200, margin: 4, errorCorrectionLevel: 'H' });
  const svg = await QRCode.toString(destination.url, { type: 'svg', margin: 4, errorCorrectionLevel: 'H' });
  await fs.writeFile(path.join(out, `${destination.slug}.svg`), svg);
  await fs.writeFile(path.join(out, `${destination.slug}.txt`), `${destination.url}\n`);
  console.log(destination.slug, destination.url);
}
