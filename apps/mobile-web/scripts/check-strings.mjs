// Fails when the app asks for a string no catalogue has (t('key'), plural('key'), k('key'), t(cond ? 'a' : 'b')),
// or when the web app's own words (res/) differ between French and English: a key missing in one language, or not
// the same placeholders. The Android catalogues it reads are checked by the Android build itself.
import fs from 'node:fs';
import path from 'node:path';
import androidStrings from './android-strings.mjs';
import { parse } from '../../tv-web/scripts/android-strings.mjs';

const app = path.resolve(import.meta.dirname, '..');
const src = path.join(app, 'src');
const code = androidStrings().load.call({ addWatchFile() {} }, '\0virtual:strings');
const { fr } = JSON.parse(code.slice('export default '.length, -1));

const problems = [];
for (const file of fs.readdirSync(src, { recursive: true })) {
  if (!/\.(ts|svelte)$/.test(file)) continue;
  const text = fs.readFileSync(path.join(src, file), 'utf8');
  for (const call of text.matchAll(/\b(t|plural|k)\(([^,)]*)/g)) {
    for (const lit of call[2].matchAll(/'([a-z][a-z0-9_]*)'/g)) {
      const table = call[1] === 'plural' ? 'plurals' : 'strings';
      if (!(lit[1] in fr[table])) problems.push(`${file}: missing ${lit[1]}`);
    }
  }
}

const own = (folder) => parse(fs.readFileSync(path.join(app, 'res', folder, 'strings.xml'), 'utf8')).strings;
const ownFr = own('values');
const ownEn = own('values-en');
const holes = (s) => (s.match(/%\d+\$[sd]/g) ?? []).sort().join(',');
for (const key of new Set([...Object.keys(ownFr), ...Object.keys(ownEn)])) {
  if (!(key in ownFr)) problems.push(`res/values: missing ${key}`);
  else if (!(key in ownEn)) problems.push(`res/values-en: missing ${key}`);
  else if (holes(ownFr[key]) !== holes(ownEn[key])) problems.push(`res: ${key} placeholders differ (${holes(ownFr[key])} / ${holes(ownEn[key])})`);
}

if (problems.length) {
  console.error(`Strings:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('strings: ok');
