// Sandboxed preload for electron-main.cjs: draws each received frame into a
// 2D canvas and reports the brightest of a few sampled pixels.
'use strict';
const { ipcRenderer, sharedTexture } = require('electron');

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
  const frame = importedSharedTexture.getVideoFrame();
  try {
    const c = document.getElementById('c');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(frame, 0, 0, c.width, c.height);
    let max = 0;
    const px = [];
    for (const [x, y] of [[40, 40], [160, 90], [280, 140], [80, 150]]) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      px.push([d[0], d[1], d[2], d[3]]);
      max = Math.max(max, d[0], d[1], d[2]);
    }
    ipcRenderer.send('pixel', { max, px, w: frame.codedWidth, h: frame.codedHeight, format: frame.format });
  } finally {
    frame.close();
    importedSharedTexture.release();
  }
});
