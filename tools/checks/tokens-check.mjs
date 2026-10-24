// The generated token files (packages/tokens/build.mjs) match tokens.json, and nothing redefines them by hand.
// Run: node tools/checks/tokens-check.mjs   (fix a failure with: node packages/tokens/build.mjs)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { argb, OUTPUTS, render } from '../../packages/tokens/build.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replaceAll('\r\n', '\n');

// The CSS to ARGB conversion reproduces the values the Android apps were hand-written with.
assert.equal(argb('#000'), '0xFF000000L');
assert.equal(argb('#0b0b0d'), '0xFF0B0B0DL');
assert.equal(argb('rgb(255 255 255 / 0.04)'), '0x0AFFFFFFL');
assert.equal(argb('rgb(235 235 245 / 0.62)'), '0x9EEBEBF5L');
assert.equal(argb('rgb(235 235 245 / 0.34)'), '0x57EBEBF5L');
assert.throws(() => argb('red'));

for (const [file, text] of Object.entries(render())) {
  assert.equal(read(file), text, `${file} is stale: run node packages/tokens/build.mjs`);
}

// app.css loads the generated file and its :root does not define a generated token again (a scoped override,
// such as reduce transparency swapping the materials, is fine).
const app = read('apps/desktop/src/renderer/app.css');
assert.match(app, /@import '\.\/tokens\.css';/);
// String.raw: in a plain template literal '\s' is just 's' and the guard never fired.
const redefines = (css, name) => [...css.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)].some(([, body]) => new RegExp(String.raw`^\s*${name}:`, 'm').test(body));
assert.ok(redefines(':root {\n  --bg: red;\n}', '--bg'), 'redefinition guard self-test');
assert.ok(!redefines(':root {\n  color: var(--bg);\n}\nhtml.x {\n  --bg: red;\n}', '--bg'), 'redefinition guard self-test');
for (const [, name] of read(OUTPUTS.css).matchAll(/^\s*(--[\w-]+):/gm)) {
  assert.ok(!redefines(app, name), `app.css redefines ${name}; edit packages/tokens/tokens.json instead`);
}
// Reduce transparency also reaches media surfaces, whose light-theme block redeclares the translucent materials.
if (/\.on-media \{[^}]*--material:/.test(read(OUTPUTS.css))) {
  assert.match(app, /html\[data-reduce-transparency\] \.on-media[^{]*\{[^}]*--material:/, 'reduce transparency must override .on-media materials');
}

// The desktop settings list every theme in tokens.json, plus 'system' (follows the OS), then desktop-only themes
// (Hyprland), which Android does not have: those are not in tokens.json and app.css gives each its default block.
const ids = Object.keys(JSON.parse(read('packages/tokens/tokens.json')).themes).filter((k) => !k.startsWith('$'));
const desktop = /export const THEMES = \[([^\]]*)\]/.exec(read('apps/desktop/src/shared/contract.ts'))?.[1].match(/'([\w-]+)'/g)?.map((x) => x.slice(1, -1));
assert.deepEqual(desktop?.slice(0, ids.length + 1), [...ids, 'system'], 'apps/desktop/src/shared/contract.ts THEMES must list the tokens.json themes, then system');
for (const id of desktop.slice(ids.length + 1)) {
  assert.ok(!ids.includes(id) && id !== 'system', `THEMES lists ${id} twice`);
  assert.match(app, new RegExp(String.raw`(?:^|\n)\[data-theme='${id}'\] \{[^}]*--bg:`), `app.css needs a [data-theme='${id}'] block with the default tokens`);
}

console.log('tokens-check: generated files up to date');
