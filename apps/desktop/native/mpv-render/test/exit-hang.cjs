// Exit paths with a libmpv core whose teardown never finishes: a Lua script
// that spins in its shutdown handler keeps mpv_terminate_destroy waiting
// forever, like a hung decoder or driver. The process must still exit, after
// the addon's bounded wait (about 2 s), through each exit path:
//   atexit      destroy() pending, then process.exit() (the atexit handler)
//   atexit-idle destroy() never called, then process.exit()
//   worker      player in a worker thread that exits (the env cleanup hook,
//               which Electron's quit also goes through)
// Plain Node only, silent (ao=null, vo=libmpv, no media). Run directly:
// `node test/exit-hang.cjs`; smoke.cjs runs it too.
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADDON = process.env.WICABY_MPV_ADDON || path.join(__dirname, '..', 'build', 'Release', 'wicaby_mpv.node');
const LIMIT_MS = 8000;

function startHungPlayer(native, script) {
  const player = native.create(() => {});
  player.setOption('vo', 'libmpv');
  player.setOption('ao', 'null');
  player.setOption('terminal', 'no');
  player.setOption('idle', 'yes');
  player.setOption('config', 'no');
  player.setOption('load-scripts', 'no');
  player.setOption('scripts', script);
  player.initialize(64, 64);
  return player;
}

function child(mode, script) {
  const native = require(ADDON);
  if (mode === 'worker') {
    const { Worker } = require('node:worker_threads');
    const w = new Worker(
      `const { workerData } = require('node:worker_threads');
       const native = require(workerData.addon);
       const p = (${startHungPlayer.toString()})(native, workerData.script);
       p.getProperty('mpv-version').then(() => process.exit(0));`,
      { eval: true, workerData: { addon: ADDON, script } },
    );
    w.on('exit', (code) => {
      console.log(`worker exited ${code}`);
      process.exit(0);
    });
    return;
  }
  const player = startHungPlayer(native, script);
  player.getProperty('mpv-version').then(() => {
    if (mode === 'atexit') void player.destroy();
    setTimeout(() => process.exit(0), 300);
  });
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-hang-'));
  const script = path.join(dir, 'hang.lua');
  fs.writeFileSync(script, 'mp.register_event("shutdown", function() while true do end end)\n');
  let failed = false;
  try {
    for (const mode of ['atexit', 'atexit-idle', 'worker']) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [__filename, mode, script], { encoding: 'utf8', timeout: LIMIT_MS });
      const ms = Date.now() - t0;
      const abandoned = /teardown did not finish/.test(r.stderr);
      const ok = r.error === undefined && r.status === 0 && abandoned && ms < LIMIT_MS;
      console.log(`${ok ? 'ok  ' : 'FAIL'} exit with a hung core (${mode}): ${ms} ms, status ${r.status}${r.error ? `, ${r.error.code}` : ''}`);
      if (!ok) {
        failed = true;
        process.stderr.write(r.stdout + r.stderr);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
  console.log('PASS');
}

if (require.main === module) {
  if (process.argv[2]) child(process.argv[2], process.argv[3]);
  else main();
}

module.exports = { main };
