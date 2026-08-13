import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const count = Number(process.argv[2] || 2500);
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const set = new Set();
while (set.size < count) {
  let code='';
  for (let i=0;i<6;i++) code += alphabet[crypto.randomInt(alphabet.length)];
  set.add(code);
}
const rows=['code,status',...Array.from(set).map(c=>`${c.slice(0,3)}-${c.slice(3)},unused`)];
const target=path.resolve(__dirname,'../data/access_codes_new.csv');
await fs.writeFile(target,rows.join('\n')+'\n');
console.log(`Generated ${count} codes at ${target}`);
