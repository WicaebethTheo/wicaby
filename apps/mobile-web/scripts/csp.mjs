// Vite plugin: the Content Security Policy of the built app, as a <meta> (static hosts such as GitHub Pages set no
// headers). Only this origin's scripts run, nothing is framed or posted elsewhere; the media server the user adds
// is reached over HTTPS (connect, images, media), the only outside origin the app talks to.
// Inline style attributes stay allowed: Svelte sets some through the markup. Left out of `npm run dev`, whose
// client is an inline module talking over a WebSocket.
const POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'upgrade-insecure-requests',
].join('; ');

export default function csp() {
  return {
    name: 'wicaby-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${POLICY}" />`),
  };
}
