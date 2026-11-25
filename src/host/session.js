// One viewer connected to this computer.
import fs from 'node:fs';
import path from 'node:path';
import { Channel, hostReply, proof, equal, b64, unb64, concat, parseJson } from '../shared/secure.js';
import { Capture, codecString } from './capture.js';
import { listShared, openShared, startUpload } from './files.js';

const MAX_IN_FLIGHT = 12;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

/** Refuses sources that keep guessing. Through a relay every viewer shares the relay's bucket. */
export class Throttle {
  constructor() { this.m = new Map(); }
  blocked(who) { return (this.m.get(who)?.until || 0) > Date.now(); }
  fail(who) {
    const e = this.m.get(who) || { n: 0, until: 0 };
    e.n++;
    if (e.n >= 5) e.until = Date.now() + Math.min(300_000, 5_000 * 2 ** (e.n - 5));
    if (this.m.size > 1000) this.m.clear();
    this.m.set(who, e);
  }
  ok(who) { this.m.delete(who); }
}

export class Session {
  /** ws: a WebSocket-like connection. ctx: { config, psk, platform, throttle, log, sessions, makePeer, testCapture } */
  constructor(ws, who, ctx) {
    Object.assign(this, { ws, who, ctx, state: 'hello', inFlight: 0, seq: 0, waitKey: true, held: new Set(), buttons: new Set(), uploads: new Map(), downloads: new Map() });
    this.viewOnly = false;
    this.settings = { codec: 'jpeg', fps: 30, maxHeight: 0, bitrate: 6000, monitor: 0 };
    this.deadline = setTimeout(() => this.close('timed out'), 20_000);
    ws.on('message', (data, binary) => { this.onRaw(data, binary).catch(e => this.close(e.message)); });
    ws.on('close', () => this.close('viewer left'));
    ws.on('error', () => this.close('connection error'));
  }
  raw(value) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(value)); }

  async onRaw(data, binary) {
    if (this.state === 'closed') return;
    if (this.state === 'hello') {
      if (binary || data.length > 2000) throw new Error('bad handshake');
      if (this.ctx.throttle.blocked(this.who)) { this.raw({ t: 'error', message: 'Too many wrong passwords. Wait a few minutes.' }); return this.close('throttled'); }
      const { keys, message } = hostReply(JSON.parse(data.toString()), unb64(this.ctx.config.salt), this.ctx.psk);
      this.keys = keys; this.state = 'proof';
      return this.raw(message);
    }
    if (this.state === 'proof') {
      const m = binary ? {} : JSON.parse(data.toString().slice(0, 1000));
      if (this.ctx.throttle.blocked(this.who)) { this.raw({ t: 'error', message: 'Too many wrong passwords. Wait a few minutes.' }); return this.close('throttled'); }
      if (m.t !== 'proof' || !equal(unb64(m.mac || ''), proof(this.keys.proofV, 'viewer'))) {
        this.ctx.throttle.fail(this.who);
        this.raw({ t: 'error', message: 'Wrong password.' });
        return this.close('wrong password');
      }
      this.ctx.throttle.ok(this.who);
      this.raw({ t: 'proof', mac: b64(proof(this.keys.proofH, 'host')) });
      this.chan = new Channel({ send: p => { if (this.ws.readyState === 1) this.ws.send(p); } }, this.keys.h2v, this.keys.v2h);
      this.chan.onmessage = m2 => this.onMessage(m2);
      this.state = 'approval';
      return this.approve();
    }
    if (!binary) throw new Error('unencrypted message');
    this.chan.receive(new Uint8Array(data));
  }

  async approve() {
    clearTimeout(this.deadline);
    const { config, platform, sessions, log } = this.ctx;
    if ([...sessions].filter(s => s.state === 'open').length >= 3) { this.chan.json({ t: 'denied', message: 'This computer already has three viewers.' }); return this.close('too many viewers'); }
    if (!config.unattended) {
      this.chan.json({ t: 'waiting' });
      if (this.ctx.asking) { this.chan.json({ t: 'denied', message: 'Another request is already waiting for an answer.' }); return this.close('busy'); }
      this.ctx.asking = true;
      let yes = false;
      try { yes = await platform.ask(`Someone who knows this computer's Many Desks password wants to see and control it.\n\nFrom: ${this.who}\n\nAllow it?`); }
      finally { this.ctx.asking = false; }
      if (this.state === 'closed') return;
      if (!yes) { this.chan.json({ t: 'denied', message: 'The request was declined or nobody answered.' }); return this.close('declined'); }
    }
    this.state = 'open';
    log(`viewer connected from ${this.who}`);
    this.monitors = await platform.monitors();
    if (!this.monitors.length) { this.chan.json({ t: 'denied', message: 'No screen was found on this computer.' }); return this.close('no screen'); }
    this.chan.json({ t: 'open', name: config.name, os: process.platform, monitors: this.monitors.map(({ width, height, primary }) => ({ width, height, primary })), p2p: !!(config.p2p && this.ctx.makePeer), stun: config.stun });
    this.lastClip = await platform.clipboard.version().catch(() => 0);
    let busy = false;
    this.clipTimer = setInterval(async () => {
      if (busy || !this.clipOn) return;
      busy = true;
      try {
        const v = await platform.clipboard.version();
        if (v !== this.lastClip) {
          this.lastClip = v;
          const text = await platform.clipboard.read();
          if (text && text.length < 1_000_000 && text !== this.clipText) { this.clipText = text; this.chan.json({ t: 'clip', text }); }
        }
      } catch { /* the clipboard was busy: try again next time */ } finally { busy = false; }
    }, 700);
    this.alive = Date.now();
    this.aliveTimer = setInterval(() => { if (Date.now() - this.alive > 30_000) this.close('viewer stopped answering'); }, 5000);
  }

  videoChan() { return this.p2pChan && this.p2pReady ? this.p2pChan : this.chan; }
  startVideo() {
    this.capture?.stop();
    this.inFlight = 0; this.waitKey = true; this.avcC = null;
    const s = this.settings, i = Math.min(s.monitor, this.monitors.length - 1);
    const c = this.capture = new Capture({ ...s, monitor: this.monitors[i], single: this.monitors.length === 1, ...this.ctx.testCapture });
    c.on('config', avcC => { this.avcC = avcC; this.waitKey = true; });
    c.on('failed', message => { if (this.state === 'open') this.chan.json({ t: 'videoError', message }); });
    c.on('packet', p => this.onPacket(p));
    if (s.codec === 'jpeg') this.sendVideoConfig();
    c.start();
  }
  sendVideoConfig() {
    const s = this.settings;
    this.videoChan().json({ t: 'video', codec: s.codec, ...(this.avcC ? { codecString: codecString(this.avcC), description: b64(this.avcC) } : {}) });
  }
  onPacket({ key, data }) {
    if (this.state !== 'open') return;
    // The viewer acknowledges each picture. If it falls behind, skip ahead to the next complete one.
    if (this.inFlight >= MAX_IN_FLIGHT) { this.waitKey = true; this.dropped = (this.dropped || 0) + 1; return; }
    if (this.waitKey) {
      if (!key) return;
      if (this.settings.codec === 'h264') { if (!this.avcC) return; this.sendVideoConfig(); }
      this.waitKey = false;
    }
    const head = new Uint8Array(6);
    head[0] = 1; head[1] = key ? 1 : 0;
    new DataView(head.buffer).setUint32(2, this.seq = (this.seq + 1) >>> 0);
    this.inFlight++;
    this.videoChan().send(concat(head, data));
  }

  onMessage(bytes) {
    if (this.state !== 'open') return;
    this.alive = Date.now();
    if (bytes[0] === 2) return this.onUploadChunk(bytes);
    if (bytes[0] !== 0) return;
    const m = parseJson(bytes);
    const { input, clipboard, lock } = this.ctx.platform;
    const can = !this.viewOnly;
    switch (m.t) {
      case 'ping': this.chan.json({ t: 'pong', at: m.at }); break;
      case 'ack': this.inFlight = Math.max(0, this.inFlight - 1); break;
      case 'settings': {
        const s = this.settings;
        if (m.codec === 'h264' || m.codec === 'jpeg') s.codec = m.codec;
        if (m.fps) s.fps = Math.round(clamp(m.fps, 5, 60));
        if (m.maxHeight !== undefined) s.maxHeight = [0, 480, 720, 1080, 1440].includes(m.maxHeight) ? m.maxHeight : 0;
        if (m.bitrate) s.bitrate = Math.round(clamp(m.bitrate, 300, 30_000));
        if (m.monitor !== undefined) s.monitor = Math.floor(clamp(m.monitor, 0, this.monitors.length - 1));
        if (m.viewOnly !== undefined) { this.viewOnly = !!m.viewOnly; this.releaseAll(); }
        if (m.clipboard !== undefined) this.clipOn = !!m.clipboard;
        if (m.restart) this.startVideo();
        break;
      }
      case 'move': if (can) this.move(m); break;
      case 'button': {
        const b = Number(m.b);
        if (!can || !Number.isInteger(b) || b < 0 || b > 4) break;
        if (m.x !== undefined) this.move(m);
        if (m.down) this.buttons.add(b); else this.buttons.delete(b);
        input.button(b, !!m.down);
        break;
      }
      case 'wheel': if (can) input.wheel(clamp(m.dx, -2400, 2400), clamp(m.dy, -2400, 2400)); break;
      case 'key': {
        if (!can || typeof m.code !== 'string') break;
        if (m.down) this.held.add(m.code); else this.held.delete(m.code);
        input.key(m.code, !!m.down);
        break;
      }
      case 'text': if (can && typeof m.text === 'string') input.text(m.text.slice(0, 5000)); break;
      case 'releaseAll': this.releaseAll(); break;
      case 'lock': if (can) lock(); break;
      case 'clip': if (can && this.clipOn && typeof m.text === 'string' && m.text.length < 1_000_000) { this.clipText = m.text; clipboard.write(m.text).catch(() => {}); } break;
      case 'rtc': this.onRtc(m).catch(() => {}); break;
      case 'list': this.files(async () => this.chan.json({ t: 'list', items: await listShared(this.ctx.config.sharedFolder) })); break;
      case 'get': this.files(() => this.startDownload(m)); break;
      case 'getAck': this.downloads.get(m.id)?.ack(); break;
      case 'put': this.files(async () => {
        if (!can) throw new Error('View-only sessions can\'t send files.');
        if (this.uploads.size >= 4) throw new Error('Too many uploads at once.');
        this.uploads.set(m.id, await startUpload(this.ctx.config.sharedFolder, m.name, m.size));
        this.chan.json({ t: 'putReady', id: m.id });
      }, m.id); break;
      case 'bye': this.close('viewer left'); break;
    }
  }
  files(work, id) { Promise.resolve().then(work).catch(e => { if (this.state === 'open') this.chan.json({ t: 'fileError', id, message: e.message }); }); }
  async startDownload(m) {
    if (this.downloads.size >= 4) throw new Error('Too many downloads at once.');
    const { handle, size, name } = await openShared(this.ctx.config.sharedFolder, m.name);
    let wake = null, credit = 16;
    const d = { handle, ack: () => { credit++; wake?.(); } };
    this.downloads.set(m.id, d);
    this.chan.json({ t: 'getReady', id: m.id, size, name });
    try {
      const head = new Uint8Array(5);
      head[0] = 3; new DataView(head.buffer).setUint32(1, m.id);
      const buf = Buffer.alloc(55_000);
      for (;;) {
        while (credit <= 0 && this.state === 'open') await new Promise(r => { wake = r; this.wakeDownloads = r; });
        if (this.state !== 'open') return;
        const { bytesRead } = await handle.read(buf, 0, buf.length, null);
        if (this.state !== 'open') return;
        if (!bytesRead) break;
        credit--;
        this.chan.send(concat(head, buf.subarray(0, bytesRead)));
      }
      this.chan.json({ t: 'getDone', id: m.id });
    } finally { this.downloads.delete(m.id); await handle.close(); }
  }
  onUploadChunk(bytes) {
    if (bytes.length < 5) return;
    const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1), u = this.uploads.get(id);
    if (!u) return;
    const data = Buffer.from(bytes.subarray(5));
    this.files(async () => {
      try {
        const done = await u.write(data);
        this.chan.json({ t: 'putAck', id });
        if (done) { this.uploads.delete(id); this.chan.json({ t: 'putDone', id, name: done }); this.ctx.log(`received file ${done}`); }
      } catch (e) { this.uploads.delete(id); u.abort(); throw e; }
    }, id);
  }

  move(m) {
    const mon = this.monitors[Math.min(this.settings.monitor, this.monitors.length - 1)];
    const at = (v, size) => Math.min(size - 1, Math.floor(clamp(v, 0, 1) * size));
    this.ctx.platform.input.move(mon.x + at(m.x, mon.width), mon.y + at(m.y, mon.height));
  }
  releaseAll() {
    for (const c of this.held) this.ctx.platform.input.key(c, false);
    for (const b of this.buttons) this.ctx.platform.input.button(b, false);
    this.held.clear(); this.buttons.clear();
  }

  /** Direct path: once open, video travels over it. Everything else stays on the first connection. */
  async onRtc(m) {
    if (!this.ctx.config.p2p || !this.ctx.makePeer) return;
    if (m.sdp && !this.peer) {
      this.peer = await this.ctx.makePeer(this.ctx.config.stun, {
        signal: s => this.chan.json({ t: 'rtc', ...s }),
        open: send => {
          this.p2pChan = new Channel({ send }, this.keys.p2pH2v, this.keys.p2pV2h);
          this.p2pChan.onmessage = () => {};
          this.chan.json({ t: 'p2p', on: true });
          this.p2pReady = true; this.inFlight = 0; this.restartAtKey();
          this.ctx.log('direct connection established');
        },
        closed: () => {
          if (!this.p2pReady || this.state !== 'open') return;
          this.p2pReady = false; this.chan.json({ t: 'p2p', on: false }); this.inFlight = 0; this.restartAtKey();
        },
      });
      this.peer.offer(m.sdp);
    } else if (m.candidate && this.peer) this.peer.candidate(m.candidate, m.mid);
  }
  restartAtKey() { if (this.capture) { this.waitKey = true; if (this.settings.codec === 'jpeg') this.sendVideoConfig(); } }

  close(reason) {
    if (this.state === 'closed') return;
    if (this.state === 'open') this.ctx.log(`viewer from ${this.who} disconnected: ${reason}`);
    else this.ctx.log(`connection from ${this.who} ended: ${reason}`);
    this.state = 'closed';
    clearTimeout(this.deadline); clearInterval(this.clipTimer); clearInterval(this.aliveTimer);
    this.capture?.stop(); this.releaseAll(); this.peer?.close();
    for (const u of this.uploads.values()) u.abort();
    for (const d of this.downloads.values()) d.ack();
    this.ctx.sessions.delete(this);
    setTimeout(() => this.ws.close(), 200).unref();
  }
}
