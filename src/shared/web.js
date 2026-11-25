// Serves the viewer page. Only the files listed here can be fetched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const PAGES = { '/': 'web/index.html', '/app.js': 'web/app.js', '/style.css': 'web/style.css', '/icon.svg': 'web/icon.svg', '/manifest.webmanifest': 'web/manifest.webmanifest', '/secure.js': 'src/shared/secure.js' };

export function serve(req, res, info) {
  const url = new URL(req.url, 'http://x').pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  if (url === '/info') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(info)); return; }
  const noble = /^\/noble\/(ciphers|curves|hashes)\/((?:abstract\/)?[\w-]+\.js)$/.exec(url);
  const rel = Object.hasOwn(PAGES, url) ? PAGES[url] : noble ? `node_modules/@noble/${noble[1]}/${noble[2]}` : null;
  if (!rel) { res.writeHead(404).end('Not found'); return; }
  fs.readFile(path.join(root, rel), (e, data) => {
    if (e) { res.writeHead(404).end('Not found'); return; }
    // Browsers resolve plain paths only, so bare package names are rewritten (an inline import map would need a looser CSP).
    if (rel.endsWith('.js')) data = data.toString().replace(/(['"])@noble\/(ciphers|curves|hashes)\//g, '$1/noble/$2/');
    res.setHeader('Content-Type', TYPES[path.extname(rel)]);
    res.end(data);
  });
}
/** Browsers always send Origin. Same site, or a page served from the person's own computer, is fine. */
export function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    return u.host === req.headers.host || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}
