// Runs smoke.cjs inside Electron's main process, then imports the addon's
// dmabufs with sharedTexture into a hidden sandboxed window and reads pixels
// back. Run (ELECTRON_RUN_AS_NODE unset):
//   electron --ozone-platform=wayland native/mpv-render/test/electron-main.cjs
'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron');
const { run, ADDON } = require('./smoke.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function textureTest(native) {
  const win = new BrowserWindow({
    width: 640,
    height: 360,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'texture-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const reports = [];
  ipcMain.on('pixel', (_e, r) => reports.push(r));
  await win.loadURL('data:text/html,<canvas id=c width=320 height=180></canvas>');

  let imports = new Map(); // `${generation}:${slot}` -> imported texture
  let sent = 0;
  let sendErrors = 0;
  let player;
  let probeAsked = false;
  let probe = null; // the addon's own readback of a frame, compared with Chromium's below
  const busy = new Set();
  player = native.create((e) => {
    if (e.type === 'buffers') {
      const next = new Map();
      for (const b of e.buffers) {
        next.set(`${e.generation}:${b.slot}`, sharedTexture.importSharedTexture({
          textureInfo: {
            pixelFormat: 'rgba',
            codedSize: { width: b.width, height: b.height },
            visibleRect: { x: 0, y: 0, width: b.width, height: b.height },
            handle: { nativePixmap: { planes: [{ fd: b.fd, stride: b.stride, offset: b.offset, size: b.size }], modifier: b.modifier, supportsZeroCopyWebGpuImport: false } },
          },
        }));
      }
      for (const t of imports.values()) t.release();
      imports = next;
    } else if (e.type === 'frame') {
      if (e.probe && !probe) probe = e.probe;
      if (!probeAsked) {
        probeAsked = true;
        player.probeNextFrame();
      }
      const key = `${e.generation}:${e.slot}`;
      const tex = imports.get(key);
      if (!tex || busy.has(key)) {
        player.releaseFrame(e.generation, e.slot);
        return;
      }
      busy.add(key);
      sharedTexture
        .sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: tex }, { generation: e.generation, slot: e.slot })
        .then(() => sent++, () => sendErrors++)
        .finally(() => {
          busy.delete(key);
          player.releaseFrame(e.generation, e.slot);
        });
    } else if (e.type === 'error') {
      console.error('render error', e.message);
    }
  });
  player.setOption('vo', 'libmpv');
  player.setOption('ao', 'null');
  player.setOption('hwdec', process.env.WICABY_TEST_HWDEC || 'no');
  player.initialize(1280, 720);
  await player.command(['loadfile', process.env.WICABY_TEST_MEDIA || 'av://lavfi:testsrc2=size=1280x720:rate=30']);
  await sleep(1500);
  player.resize(640, 360);
  await sleep(1000);
  await player.destroy();
  for (const t of imports.values()) t.release();
  await sleep(200);
  win.destroy();

  const lit = reports.filter((r) => r.max > 40);
  const sizes = [...new Set(reports.map((r) => `${r.w}x${r.h}`))];
  console.log(`texture: sent=${sent} sendErrors=${sendErrors} received=${reports.length} non-black=${lit.length} sizes=${sizes.join(',')}`);
  console.log(`texture: sample pixels ${JSON.stringify(reports.slice(0, 3).map((r) => r.px))}`);
  if (reports.length < 20 || lit.length !== reports.length || sendErrors > 0 || !sizes.includes('1280x720') || !sizes.includes('640x360')) {
    throw new Error('FAIL sharedTexture import/readback');
  }
  console.log('ok   sharedTexture import of emitted buffers reads back non-black pixels at both sizes');
  if (!process.env.WICABY_TEST_MEDIA) {
    // testsrc2 has red at (160,160) and blue at (640,360) of 1280x720: proves
    // the AB24 <-> 'rgba' channel order and that the image is upright.
    const [red, blue] = reports[0].px;
    if (!(red[0] > 200 && red[2] < 60 && blue[2] > 200 && blue[0] < 60)) throw new Error(`FAIL colours ${JSON.stringify(reports[0].px)}`);
    console.log('ok   channel order and orientation match testsrc2');
    // The addon's probe reads the same dmabuf before Chromium does: its first
    // point, (640,360) at 1280x720, must be the same blue.
    console.log(`texture: native probe ${JSON.stringify(probe)}`);
    if (!(probe && probe[0] === 640 && probe[1] === 360 && probe[4] > 200 && probe[2] < 60)) throw new Error('FAIL native probe disagrees with Chromium');
    console.log('ok   native pixel probe matches the Chromium readback');
  }
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    console.log(`electron ${process.versions.electron}, platform ${app.commandLine.getSwitchValue('ozone-platform') || 'default'}`);
    const native = require(ADDON);
    await run(native);
    await textureTest(native);
  } catch (err) {
    console.error(err.stack || String(err));
    code = 1;
  }
  app.exit(code);
});
