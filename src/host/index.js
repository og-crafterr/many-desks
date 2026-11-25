import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { stretch, unb64 } from '../shared/secure.js';
import { serve, originAllowed } from '../shared/web.js';
import { Session, Throttle } from './session.js';

/** 127.0.0.1 always; Tailscale addresses (100.64.0.0/10) if there are any; home-network ones only when asked. */
export function listenAddresses(lan, interfaces = os.networkInterfaces()) {
  const out = ['127.0.0.1'];
  for (const list of Object.values(interfaces)) for (const a of list) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const [p, q] = a.address.split('.').map(Number);
    const tailscale = p === 100 && q >= 64 && q < 128;
    const home = p === 10 || (p === 192 && q === 168) || (p === 172 && q >= 16 && q < 32);
    if (tailscale || (lan && home)) out.push(a.address);
  }
  return out;
}
async function loadPeers() {
  try {
    const { PeerConnection } = (await import('node-datachannel')).default;
    let n = 0;
    return async (stun, on) => {
      const pc = new PeerConnection('host' + n++, { iceServers: stun });
      pc.onLocalDescription((sdp, type) => on.signal({ sdp: { type, sdp } }));
      pc.onLocalCandidate((candidate, mid) => on.signal({ candidate, mid }));
      pc.onStateChange(s => { if (['disconnected', 'failed', 'closed'].includes(s)) on.closed(); });
      pc.onDataChannel(dc => {
        const open = () => on.open(p => { try { dc.sendMessageBinary(p); } catch { on.closed(); } });
        dc.onClosed(() => on.closed());
        if (dc.isOpen()) open(); else dc.onOpen(open);
      });
      return {
        offer: d => pc.setRemoteDescription(String(d.sdp), 'offer'),
        candidate: (c, mid) => { try { pc.addRemoteCandidate(String(c), String(mid ?? '0')); } catch { /* a candidate we can't use */ } },
        close: () => { try { pc.close(); } catch { /* already gone */ } },
      };
    };
  } catch { return null; }
}

export async function startHost(config, options = {}) {
  const log = options.log || (m => console.log(`${new Date().toISOString()}  ${m}`));
  const platform = options.platform || await import(process.platform === 'win32' ? './platform-win32.js' : './platform-linux.js');
  const ctx = {
    config, platform, log, throttle: new Throttle(), sessions: new Set(), testCapture: options.testCapture,
    psk: stretch(config.password, unb64(config.salt)), makePeer: config.p2p ? await loadPeers() : null,
  };
  const accept = (ws, who) => { if (ctx.sessions.size >= 20) ws.close(); else ctx.sessions.add(new Session(ws, who, ctx)); };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });
  const servers = [];
  for (const address of options.addresses || listenAddresses(config.lan)) {
    const server = http.createServer((q, s) => serve(q, s, { app: 'many-desks', kind: 'host', name: config.name }));
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      if (new URL(req.url, 'http://x').pathname !== '/connect' || !originAllowed(req)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head, ws => accept(ws, req.socket.remoteAddress));
    });
    try {
      await new Promise((ok, no) => { server.once('error', no); server.listen(config.port, address, ok); });
      servers.push(server);
      log(`listening on http://${address}:${server.address().port}`);
    } catch (e) {
      if (address === '127.0.0.1') throw new Error(`Port ${config.port} is in use. Is Many Desks already running?`);
      log(`can't listen on ${address}: ${e.message}`);
    }
  }

  let stopped = false, control = null, timer = null, delay = 1000;
  function dial() {
    if (stopped) return;
    const base = config.relay.url.replace(/\/+$/, '').replace(/^http/, 'ws');
    const ws = control = new WebSocket(base + '/host', { maxPayload: 65536, handshakeTimeout: 10000 });
    let beat;
    ws.on('open', () => { beat = setInterval(() => { if (ws.dead) ws.terminate(); ws.dead = true; ws.ping(); }, 20000); });
    ws.on('pong', () => { ws.dead = false; });
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.t === 'challenge') {
        const signed = `many-desks-relay:${m.nonce}:${config.relay.token}`;
        ws.send(JSON.stringify({ t: 'register', public: config.identity.public, token: config.relay.token, sig: crypto.sign(null, Buffer.from(signed), config.identity.private).toString('base64') }));
      } else if (m.t === 'registered') { delay = 1000; log(`reachable through the relay as ${m.id}`); options.onRegistered?.(m.id); }
      else if (m.t === 'error') { delay = 60000; log(`relay refused this computer: ${m.message}`); }
      else if (m.t === 'viewer') {
        const t = new WebSocket(`${base}/tunnel?key=${encodeURIComponent(m.key)}`, { maxPayload: 1 << 20, perMessageDeflate: false, handshakeTimeout: 10000 });
        t.on('error', () => {});
        t.on('open', () => accept(t, `relay (${String(m.from).slice(0, 60)})`));
      }
    });
    ws.on('error', e => log(`relay: ${e.message}`));
    ws.on('close', () => { clearInterval(beat); if (!stopped) { timer = setTimeout(dial, delay); delay = Math.min(60000, delay * 2); } });
  }
  if (config.relay) dial();
  return {
    port: servers[0].address().port, ctx,
    stop() {
      stopped = true; clearTimeout(timer); control?.terminate();
      for (const s of [...ctx.sessions]) s.close('host stopped');
      for (const s of servers) { s.close(); s.closeAllConnections(); }
      for (const c of wss.clients) c.terminate();
    },
  };
}
