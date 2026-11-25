import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import * as S from '../src/shared/secure.js';
import { FlvParser, JpegParser, Capture } from '../src/host/capture.js';
import { safeName, startUpload, openShared, listShared } from '../src/host/files.js';
import { listenAddresses, startHost } from '../src/host/index.js';
import { newPassword, idOf } from '../src/host/config.js';
import { startRelay } from '../src/relay/index.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'manydesks-'));
const TOKEN = 'a-test-token-of-some-length';
function identity() {
  const k = crypto.generateKeyPairSync('ed25519');
  return { public: k.publicKey.export({ type: 'spki', format: 'pem' }), private: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
async function makeConfig(extra = {}) {
  const id = identity();
  return { name: 'test-host', password: 'abcd-efgh-jkmn-pqrst', salt: crypto.randomBytes(16).toString('base64'), port: 0, lan: false, unattended: true, relay: null, stun: [], p2p: false, sharedFolder: await tmp(), identity: id, id: idOf(id.public), ...extra };
}
function fakePlatform(answer = true) {
  const calls = [];
  const rec = name => (...a) => { calls.push([name, ...a]); };
  return { calls, monitors: () => [{ x: 100, y: 50, width: 640, height: 360, primary: true }], ask: async () => answer, lock: rec('lock'),
    input: { move: rec('move'), button: rec('button'), wheel: rec('wheel'), key: rec('key'), text: rec('text') },
    clipboard: { version: async () => 1, read: async () => null, write: async t => { calls.push(['clip', t]); return true; } } };
}
/** A minimal viewer. */
function connect(url, password, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers }), { state, message } = S.viewerHello(), got = [], waits = [];
    let keys, chan, stage = 0;
    const api = { ws, got, get chan() { return chan; }, keys: () => keys,
      wait: f => { const hit = got.find(f); return hit ? Promise.resolve(hit) : new Promise(r => waits.push([f, r])); } };
    const push = m => { got.push(m); for (const w of [...waits]) if (w[0](m)) { waits.splice(waits.indexOf(w), 1); w[1](m); } };
    ws.on('open', () => ws.send(JSON.stringify(message)));
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('closed')));
    ws.on('message', (d, binary) => {
      if (binary) return chan.receive(new Uint8Array(d));
      const m = JSON.parse(d);
      if (m.t === 'error') return reject(new Error(m.message));
      if (stage++ === 0) { keys = S.viewerKeys(state, m, password); ws.send(JSON.stringify({ t: 'proof', mac: S.b64(S.proof(keys.proofV, 'viewer')) })); return; }
      assert.ok(S.equal(S.unb64(m.mac), S.proof(keys.proofH, 'host')));
      chan = new S.Channel({ send: p => ws.send(p) }, keys.v2h, keys.h2v);
      chan.onmessage = b => push(b[0] === 0 ? S.parseJson(b) : { bin: b[0], bytes: b });
      resolve(api);
    });
  });
}
const quiet = { log() {}, addresses: ['127.0.0.1'] };

test('an encrypted channel carries large messages and refuses tampering and replays', () => {
  const salt = S.random(16), psk = S.stretch('Correct Horse-battery', salt), h = S.viewerHello();
  const r = S.hostReply(h.message, salt, psk), k = S.viewerKeys(h.state, r.message, 'correcthorsebattery');
  const wire = [], a = new S.Channel({ send: p => wire.push(p) }, r.keys.h2v, r.keys.v2h), b = new S.Channel({}, k.v2h, k.h2v);
  const big = crypto.randomBytes(200_000); let out; b.onmessage = m => { out = m; };
  a.send(big);
  assert.ok(wire.length > 1 && wire.every(p => p.length < 65536));
  for (const p of wire) b.receive(p);
  assert.ok(S.equal(out, big));
  assert.throws(() => b.receive(wire[0]));
  const c = new S.Channel({}, k.v2h, k.h2v), bad = wire[0].slice(); bad[5] ^= 1;
  assert.throws(() => c.receive(bad));
});
test('a man in the middle without the password ends up with different keys', () => {
  const salt = S.random(16), h = S.viewerHello();
  const mitm = S.hostReply(h.message, salt, S.stretch('a guess that is wrong', salt));
  const viewer = S.viewerKeys(h.state, mitm.message, 'the real password 123');
  assert.ok(!S.equal(S.proof(viewer.proofV, 'viewer'), S.proof(mitm.keys.proofV, 'viewer')));
  assert.ok(!S.equal(viewer.h2v, mitm.keys.h2v));
});
test('generated passwords are long and differ', () => {
  const a = newPassword();
  assert.ok(S.normalizePassword(a).length >= 16);
  assert.notEqual(a, newPassword());
});
test('only loopback and Tailscale are listened on unless the home network is turned on', () => {
  const n = { a: [{ family: 'IPv4', address: '192.168.1.5' }, { family: 'IPv4', address: '8.8.8.8' }], t: [{ family: 'IPv4', address: '100.100.1.2' }] };
  assert.deepEqual(listenAddresses(false, n), ['127.0.0.1', '100.100.1.2']);
  assert.deepEqual(listenAddresses(true, n), ['127.0.0.1', '192.168.1.5', '100.100.1.2']);
});
test('file names cannot leave the shared folder, and uploads never overwrite', async () => {
  for (const n of ['../../x.txt', '..\\..\\x.txt', 'C:\\a\\x.txt', '/etc/x.txt']) assert.equal(safeName(n), 'x.txt');
  for (const n of ['..', '', '/', '...']) assert.throws(() => safeName(n));
  assert.notEqual(safeName('CON.txt'), 'CON.txt');
  const d = await tmp();
  const put = async t => (await startUpload(d, 'a.txt', t.length)).write(Buffer.from(t));
  assert.equal(await put('one'), 'a.txt');
  assert.equal(await put('two'), 'a (1).txt');
  assert.equal(await fs.readFile(path.join(d, 'a.txt'), 'utf8'), 'one');
  const u = await startUpload(d, 'b.txt', 2);
  await assert.rejects(u.write(Buffer.from('toolong')));
  u.abort();
  await assert.rejects(openShared(d, '../a.txt'));
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await listShared(d)).length, 2);
});
test('ffmpeg output is split into pictures even in tiny pieces', async () => {
  for (const codec of ['h264', 'jpeg']) {
    const c = new Capture({ platform: 'test', monitor: { x: 0, y: 0, width: 320, height: 180 }, fps: 30, codec, bitrate: 800, maxHeight: 0, single: true });
    let config = 0, frames = 0, first;
    await new Promise((ok, no) => {
      c.on('config', () => config++); c.on('failed', m => no(new Error(m)));
      c.on('packet', p => { first ??= p; if (++frames === 10) ok(); });
      c.start();
    });
    c.stop();
    assert.ok(first.key);
    if (codec === 'h264') assert.ok(config >= 1); else assert.equal(first.data.readUInt16BE(0), 0xffd8);
  }
  const j = []; const p = new JpegParser(x => j.push(x.data.length));
  for (const b of Buffer.from('ffd80102ffd9ffd803ffd9', 'hex')) p.push(Buffer.from([b]));
  assert.deepEqual(j, [6, 5]);
  assert.throws(() => new FlvParser(() => {}).push(Buffer.alloc(20)));
});
test('a direct connection shows video, forwards input and releases held keys on disconnect', async t => {
  const platform = fakePlatform(), config = await makeConfig();
  const h = await startHost(config, { ...quiet, platform, testCapture: { platform: 'test' } });
  t.after(() => h.stop());
  const v = await connect(`ws://127.0.0.1:${h.port}/connect`, config.password);
  assert.equal((await v.wait(m => m.t === 'open')).name, 'test-host');
  v.chan.json({ t: 'settings', codec: 'h264', restart: true, clipboard: true });
  const cfg = await v.wait(m => m.t === 'video');
  assert.match(cfg.codecString, /^avc1\./);
  await v.wait(m => m.bin === 1);
  v.chan.json({ t: 'move', x: 0.5, y: 0.5 });
  v.chan.json({ t: 'button', b: 0, down: true, x: 2, y: -1 });
  v.chan.json({ t: 'key', code: 'ShiftLeft', down: true });
  v.chan.json({ t: 'clip', text: 'hé' });
  v.chan.json({ t: 'ping', at: 1 });
  await v.wait(m => m.t === 'pong');
  assert.deepEqual(platform.calls.slice(0, 2), [['move', 420, 230], ['move', 739, 50]]);
  assert.ok(platform.calls.some(c => c[0] === 'clip' && c[1] === 'hé'));
  // video stops growing when the viewer doesn't acknowledge it
  await new Promise(r => setTimeout(r, 1500));
  assert.ok(v.got.filter(m => m.bin === 1).length <= 12);
  v.ws.on('close', () => {}); v.ws.terminate();
  await new Promise(r => setTimeout(r, 200));
  assert.ok(platform.calls.some(c => c[0] === 'key' && c[1] === 'ShiftLeft' && c[2] === false));
  assert.ok(platform.calls.some(c => c[0] === 'button' && c[1] === 0 && c[2] === false));
});
test('view-only blocks input', async t => {
  const platform = fakePlatform(), config = await makeConfig();
  const h = await startHost(config, { ...quiet, platform });
  t.after(() => h.stop());
  const v = await connect(`ws://127.0.0.1:${h.port}/connect`, config.password);
  await v.wait(m => m.t === 'open');
  v.chan.json({ t: 'settings', viewOnly: true });
  for (const m of [{ t: 'move', x: 0, y: 0 }, { t: 'text', text: 'x' }, { t: 'key', code: 'KeyA', down: true }, { t: 'lock' }]) v.chan.json(m);
  v.chan.json({ t: 'ping' }); await v.wait(m => m.t === 'pong');
  assert.deepEqual(platform.calls, []);
});
test('nothing is sent before approval, and a refusal ends the connection', async t => {
  const platform = fakePlatform(false), config = await makeConfig({ unattended: false });
  const h = await startHost(config, { ...quiet, platform });
  t.after(() => h.stop());
  const v = await connect(`ws://127.0.0.1:${h.port}/connect`, config.password);
  v.chan.json({ t: 'move', x: 0, y: 0 });
  await v.wait(m => m.t === 'denied');
  assert.deepEqual(v.got.map(m => m.t), ['waiting', 'denied']);
  assert.deepEqual(platform.calls, []);
});
test('wrong passwords are refused and then throttled; foreign web pages are refused', async t => {
  const config = await makeConfig(), h = await startHost(config, { ...quiet, platform: fakePlatform() });
  t.after(() => h.stop());
  const url = `ws://127.0.0.1:${h.port}/connect`;
  for (let i = 0; i < 5; i++) await assert.rejects(connect(url, 'not the password at all'), /Wrong password/);
  await assert.rejects(connect(url, config.password), /Too many/);
  await assert.rejects(connect(url, config.password, { origin: 'https://evil.example' }), /403/);
});
test('files travel both ways', async t => {
  const config = await makeConfig(), h = await startHost(config, { ...quiet, platform: fakePlatform() });
  t.after(() => h.stop());
  const v = await connect(`ws://127.0.0.1:${h.port}/connect`, config.password);
  await v.wait(m => m.t === 'open');
  const data = crypto.randomBytes(2_500_000), head = Uint8Array.of(2, 0, 0, 0, 7);
  v.chan.json({ t: 'put', id: 7, name: 'big.bin', size: data.length });
  await v.wait(m => m.t === 'putReady');
  for (let i = 0; i < data.length; i += 50_000) v.chan.send(S.concat(head, data.subarray(i, i + 50_000)));
  assert.equal((await v.wait(m => m.t === 'putDone')).name, 'big.bin');
  assert.ok(data.equals(await fs.readFile(path.join(config.sharedFolder, 'big.bin'))));
  v.chan.json({ t: 'get', id: 9, name: 'big.bin' });
  const seen = new Set();
  const iv = setInterval(() => { for (const m of v.got) if (m.bin === 3 && !seen.has(m)) { seen.add(m); v.chan.json({ t: 'getAck', id: 9 }); } }, 5);
  await v.wait(m => m.t === 'getDone'); clearInterval(iv);
  assert.ok(data.equals(Buffer.concat(v.got.filter(m => m.bin === 3).map(m => m.bytes.subarray(5)))));
  v.chan.json({ t: 'get', id: 10, name: '../config.json' });
  await v.wait(m => m.t === 'fileError');
});
test('a relay joins both sides without being able to read anything', async t => {
  const relay = await startRelay({ port: 0, token: TOKEN, log() {} });
  t.after(() => relay.stop());
  const config = await makeConfig({ relay: { url: `http://127.0.0.1:${relay.port}`, token: TOKEN } });
  let registered; const ready = new Promise(r => { registered = r; });
  const h = await startHost(config, { ...quiet, platform: fakePlatform(), testCapture: { platform: 'test' }, onRegistered: registered });
  t.after(() => h.stop());
  assert.equal(await ready, config.id);
  const v = await connect(`ws://127.0.0.1:${relay.port}/connect?id=${config.id}`, config.password);
  await v.wait(m => m.t === 'open');
  v.chan.json({ t: 'settings', codec: 'jpeg', restart: true });
  await v.wait(m => m.bin === 1);
  await assert.rejects(connect(`ws://127.0.0.1:${relay.port}/connect?id=111111111111`, 'x'), /online/);
  await assert.rejects(connect(`ws://127.0.0.1:${relay.port}/tunnel?key=nope`, 'x'), /404/);
});
test('a relay refuses hosts without its token', async t => {
  const relay = await startRelay({ port: 0, token: TOKEN, log() {} });
  t.after(() => relay.stop());
  const logs = [], config = await makeConfig({ relay: { url: `http://127.0.0.1:${relay.port}`, token: 'wrong-token' } });
  const h = await startHost(config, { ...quiet, log: m => logs.push(m), platform: fakePlatform() });
  t.after(() => h.stop());
  await new Promise(r => setTimeout(r, 500));
  assert.equal(relay.hosts.size, 0);
  assert.ok(logs.some(l => /Wrong relay token/.test(l)));
});
