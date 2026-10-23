// Vite plugin: `virtual:strings`, the Android apps' own words (see apps/tv-web/scripts/android-strings.mjs). The
// phone speaks like the Android mobile app; the TV app's strings come first so the shared TV web logic finds its
// keys, and :mobile is read last so its wording wins where both modules name a key. res/ holds the few words only
// the web app says, in the same format.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../../tv-web/scripts/android-strings.mjs';

const ANDROID = path.resolve(import.meta.dirname, '..', '..', 'android');
const RES_DIRS = ['tv', 'livetv-ui', 'core', 'mobile'].map((m) => path.join(ANDROID, m, 'src', 'main', 'res'));
RES_DIRS.push(path.resolve(import.meta.dirname, '..', 'res'));
const ID = 'virtual:strings';

function resourceFiles(folder) {
  return RES_DIRS.flatMap((m) => {
    const dir = path.join(m, folder);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.xml')).map((f) => path.join(dir, f)) : [];
  });
}

function load(folder) {
  const out = { strings: {}, plurals: {} };
  for (const file of resourceFiles(folder)) {
    const { strings, plurals } = parse(fs.readFileSync(file, 'utf8'));
    Object.assign(out.strings, strings);
    Object.assign(out.plurals, plurals);
  }
  return out;
}

export default function androidStrings() {
  return {
    name: 'wicaby-android-strings',
    resolveId: (id) => (id === ID ? '\0' + ID : null),
    load(id) {
      if (id !== '\0' + ID) return null;
      for (const f of [...resourceFiles('values'), ...resourceFiles('values-en')]) this.addWatchFile(f);
      return `export default ${JSON.stringify({ fr: load('values'), en: load('values-en') })};`;
    },
  };
}
