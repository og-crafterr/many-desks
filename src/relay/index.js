// The relay joins a viewer and a host that both connect outwards to it. It only ever sees encrypted bytes.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { serve, originAllowed } from '../shared/web.js';
import { idOf } from '../host/config.js';

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const HIGH = 4 << 20, LOW = 1 << 20;

export function startRelay({ port = 7879, address = '127.0.0.1', token, trustProxy = false, log = m => console.log(`${new Date().toISOString()}  ${m}`) }) {
  if (!token || token.length < 16) throw new Error('The relay needs a token of at least 16 characters.');
  const hosts = new Map(), pending = new Map(), attempts = new Map();
  const sweep = setInterval(() => attempts.clear(), 60000); sweep.unref();
  const limited = (ip, max) => { const n = (attempts.get(ip) || 0) + 1; attempts.set(ip, n); return n > max; };
  const ipOf = req => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress;
  const server = http.createServer((q, s) => serve(q, s, { app: 'many-desks', kind: 'relay' }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const url = new URL(req.url, 'http://x'), ip = ipOf(req);
    const refuse = code => socket.end(`HTTP/1.1 ${code}\r\n\r\n`);
    const up = f => wss.handleUpgrade(req, socket, head, ws => { ws.on('error', () => {}); f(ws); });
    if (!originAllowed(req)) return refuse('403 Forbidden');
    if (url.pathname === '/tunnel') {
      const wait = pending.get(url.searchParams.get('key'));
      if (!wait) return refuse('404 Not Found');
      pending.delete(url.searchParams.get('key'));
      return up(wait);
    }
    if (limited(ip, 60)) return refuse('429 Too Many Requests');
    if (url.pathname === '/host') return up(ws => onHost(ws, ip));
    if (url.pathname === '/connect') return up(ws => onViewer(ws, url.searchParams.get('id'), ip));
    refuse('404 Not Found');
  });

  function onHost(ws, ip) {
    const nonce = crypto.randomBytes(24).toString('base64');
    const late = setTimeout(() => ws.terminate(), 10000);
    ws.send(JSON.stringify({ t: 'challenge', nonce }));
    ws.once('message', d => {
      clearTimeout(late);
      const no = message => { ws.send(JSON.stringify({ t: 'error', message })); ws.close(); };
      try {
        if (d.length > 4000) return no('Bad request.');
        const m = JSON.parse(d);
        if (!crypto.timingSafeEqual(sha(m.token), sha(token))) return no('Wrong relay token.');
        const pub = crypto.createPublicKey(String(m.public));
        if (pub.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, Buffer.from(`many-desks-relay:${nonce}:${token}`), pub, Buffer.from(String(m.sig), 'base64'))) return no('Bad signature.');
        // The address comes from the key, so nobody can take over another computer's address.
        const id = idOf(pub.export({ type: 'spki', format: 'pem' }));
        hosts.get(id)?.terminate();
        hosts.set(id, ws);
        let alive = true;
        ws.on('pong', () => { alive = true; });
        const beat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 25000);
        ws.on('close', () => { clearInterval(beat); if (hosts.get(id) === ws) hosts.delete(id); log(`host ${id} left`); });
        ws.send(JSON.stringify({ t: 'registered', id }));
        log(`host ${id} registered from ${ip}`);
      } catch { no('Bad request.'); }
    });
    ws.on('close', () => clearTimeout(late));
  }

  function onViewer(viewer, id, ip) {
    const host = hosts.get(String(id));
    if (!host) { viewer.send(JSON.stringify({ t: 'error', message: 'That computer isn\'t online.' })); return viewer.close(); }
    if (pending.size >= 200) return viewer.close();
    const key = crypto.randomBytes(24).toString('base64url'), early = [];
    let earlyBytes = 0;
    const hold = (d, binary) => { earlyBytes += d.length; if (earlyBytes > 65536) viewer.terminate(); else early.push([d, binary]); };
    viewer.on('message', hold);
    const late = setTimeout(() => { pending.delete(key); viewer.close(); }, 15000);
    viewer.on('close', () => { clearTimeout(late); pending.delete(key); });
    pending.set(key, tunnel => {
      clearTimeout(late);
      viewer.off('message', hold);
      for (const [d, binary] of early) tunnel.send(d, { binary });
      pipe(viewer, tunnel); pipe(tunnel, viewer);
    });
    host.send(JSON.stringify({ t: 'viewer', key, from: ip }));
  }
  function pipe(a, b) {
    let alive = true;
    a.on('pong', () => { alive = true; });
    const beat = setInterval(() => { if (!alive) return a.terminate(); alive = false; a.ping(); }, 25000);
    a.on('message', (d, binary) => {
      if (b.readyState !== 1) return;
      b.send(d, { binary }, () => { if (a.isPaused && b.bufferedAmount < LOW) a.resume(); });
      if (b.bufferedAmount > HIGH) a.pause();
    });
    a.on('close', () => { clearInterval(beat); b.close(); });
  }
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, address, () => {
      log(`relay listening on http://${address}:${server.address().port}`);
      ok({ port: server.address().port, hosts, stop() { clearInterval(sweep); server.close(); for (const c of wss.clients) c.terminate(); server.closeAllConnections(); } });
    });
  });
}
