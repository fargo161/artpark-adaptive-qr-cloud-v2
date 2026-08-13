import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, migrate } from '../db.js';
import { normalizeAccessCode } from '../lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.resolve(__dirname, '../data/access_codes.csv');
await migrate();
const text = await fs.readFile(file, 'utf8');
const lines = text.split(/\r?\n/).filter(Boolean);
let inserted = 0;
for (let i = 1; i < lines.length; i += 1) {
  const first = lines[i].split(',')[0];
  const code = normalizeAccessCode(first);
  if (!code) continue;
  const result = await pool.query('INSERT INTO access_codes(code) VALUES($1) ON CONFLICT (code) DO NOTHING', [code]);
  inserted += result.rowCount;
}
console.log(`Imported ${inserted} new access codes from ${file}`);
await pool.end();
