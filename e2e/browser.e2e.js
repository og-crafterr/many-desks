// Drives the real viewer in installed Chrome. Input goes to a recorder, never to this computer.
// Usage: node e2e/browser.e2e.js [--real-screen]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startHost, listenAddresses } from '../src/host/index.js';
import { startRelay } from '../src/relay/index.js';
import { idOf } from '../src/host/config.js';

const real = process.argv.includes('--real-screen');
const out = path.resolve('test-output'); await fs.mkdir(out, { recursive: true });
const TOKEN = 'browser-test-relay-token';
const calls = [], rec = n => (...a) => calls.push([n, ...a]);
let screens = [{ x: 0, y: 0, width: 1280, height: 720, primary: true }];
if (real) screens = (await import('../src/host/platform-win32.js')).monitors();
let clipVersion = 1, clipText = null;
const platform = { monitors: () => screens, ask: async () => true, lock: rec('lock'),
  input: { move: rec('move'), button: rec('button'), wheel: rec('wheel'), key: rec('key'), text: rec('text') },
  clipboard: { version: async () => clipVersion, read: async () => clipText, write: async t => { calls.push(['clip', t]); } } };
const k = crypto.generateKeyPairSync('ed25519');
const identity = { public: k.publicKey.export({ type: 'spki', format: 'pem' }), private: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const relay = await startRelay({ port: 0, token: TOKEN, log() {} });
let registered; const ready = new Promise(r => { registered = r; });
const addresses = listenAddresses(false);
const config = { id: idOf(identity.public), name: 'e2e-host', password: 'abcd-efgh-jkmn-pqrst', salt: crypto.randomBytes(16).toString('base64'), port: 18788, unattended: true, p2p: true, stun: [], identity, relay: { url: `http://127.0.0.1:${relay.port}`, token: TOKEN }, sharedFolder: await fs.mkdtemp(path.join(os.tmpdir(), 'manydesks-')) };
const logs = [];
const host = await startHost(config, { platform, addresses, log: m => logs.push(m), onRegistered: registered, ...(real ? {} : { testCapture: { platform: 'test' } }) });
await ready;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failed = false;
async function scenario(name, page, address, body) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    calls.length = 0;
    await page.fill('#address', address); await page.fill('#password', config.password); await page.click('#go');
    await page.waitForFunction(() => !document.getElementById('desk').hidden && document.getElementById('screen').width > 100, null, { timeout: 25000 });
    await page.waitForTimeout(3500);
    console.log(`${name}: ${await page.textContent('#stats')} secure=${await page.evaluate(() => isSecureContext)}`);
    if (!real) await page.screenshot({ path: path.join(out, name + '.png') });
    const colours = await page.evaluate(() => { const c = document.getElementById('screen'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, set = new Set(); for (let i = 0; i < d.length; i += 4004) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return set.size; });
    assert.ok(colours > 20, `picture has only ${colours} colours`);
    await body?.(page);
    assert.deepEqual(errors, []);
    console.log(`${name}: ok`);
  } catch (e) { failed = true; console.log(`${name}: FAILED ${e.message}\n${errors.join('\n')}`); await page.screenshot({ path: path.join(out, name + '-failed.png') }).catch(() => {}); }
  await page.context().close();
  await new Promise(r => setTimeout(r, 500));
}
const open = async (url, options = {}) => { const c = await browser.newContext({ viewport: { width: 1300, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'], ...options }); const p = await c.newPage(); await p.goto(url); return p; };
const settle = p => p.waitForTimeout(500);

await scenario('local-h264', await open(`http://127.0.0.1:${config.port}`), `127.0.0.1:${config.port}`, async p => {
  assert.equal(await p.evaluate(() => 'VideoDecoder' in window), true);
  const b = await p.locator('#screen').boundingBox();
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  await p.mouse.wheel(0, 100); await p.keyboard.press('Shift+A'); await settle(p);
  const m = calls.find(c => c[0] === 'move');
  assert.ok(Math.abs(m[1] - screens[0].width / 2) <= 2 && Math.abs(m[2] - screens[0].height / 2) <= 2, String(m));
  assert.deepEqual(calls.filter(c => c[0] === 'button').map(c => c.slice(1)), [[2, true], [2, false]]);
  assert.ok(calls.some(c => c[0] === 'wheel' && c[2] > 0));
  assert.deepEqual(calls.filter(c => c[0] === 'key').map(c => c.slice(1)), [['ShiftLeft', true], ['KeyA', true], ['KeyA', false], ['ShiftLeft', false]]);
  await p.evaluate(() => navigator.clipboard.writeText('from viewer')); await p.keyboard.press('Control+V'); await settle(p);
  const ci = calls.findIndex(c => c[0] === 'clip' && c[1] === 'from viewer'), vi = calls.findIndex(c => c[0] === 'key' && c[1] === 'KeyV' && c[2]);
  assert.ok(ci >= 0 && vi > ci, 'clipboard goes before the paste key');
  clipText = 'from host'; clipVersion++; await p.waitForTimeout(1500);
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), 'from host');
  await p.setInputFiles('#upload', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await p.waitForSelector('#remote button:has-text("note.txt")');
  assert.equal(await fs.readFile(path.join(config.sharedFolder, 'note.txt'), 'utf8'), 'hello');
  const [d] = await Promise.all([p.waitForEvent('download'), p.click('#remote button:has-text("note.txt")')]);
  assert.equal(await fs.readFile(await d.path(), 'utf8'), 'hello');
  await p.selectOption('#quality', 'low'); await p.waitForFunction(h => document.getElementById('screen').height === Math.min(720, h), screens[0].height);
  await p.click('#leave'); await p.waitForSelector('#saved button:has-text("e2e-host")');
});
const ts = addresses.find(a => a.startsWith('100.'));
if (ts) await scenario('insecure-page-jpeg', await open(`http://${ts}:${config.port}`), `${ts}:${config.port}`, async p => {
  assert.equal(await p.evaluate(() => isSecureContext), false);
});
if (ts) await scenario('own-computer-page-to-another-address', await open(`http://127.0.0.1:${config.port}`), `${ts}:${config.port}`, async p => {
  assert.equal(await p.evaluate(() => 'VideoDecoder' in window), true);
});
else console.log('no Tailscale address: insecure page not tried');
await scenario('relay-and-direct-path', await open(`http://127.0.0.1:${relay.port}`), config.id, async p => {
  await p.waitForFunction(() => document.getElementById('stats').textContent.endsWith('direct'), null, { timeout: 15000 });
  await p.waitForTimeout(3500);
  const fps = parseInt(await p.textContent('#stats'));
  console.log('  over the direct path:', await p.textContent('#stats'));
  if (!real) assert.ok(fps > 15, `${fps} fps`);
});
config.p2p = false; host.ctx.makePeer = null;
await scenario('relay-only', await open(`http://127.0.0.1:${relay.port}`), config.id, async p => {
  assert.ok((await p.textContent('#stats')).endsWith('relay'));
  relay.hosts.get(config.id).terminate(); // the host must come back by itself
  for (let i = 0; i < 50 && !relay.hosts.has(config.id); i++) await p.waitForTimeout(200);
  assert.ok(relay.hosts.has(config.id), 'host reconnects to the relay');
});
await scenario('phone', await open(`http://127.0.0.1:${config.port}`, { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true }), `127.0.0.1:${config.port}`, async p => {
  const b = await p.locator('#screen').boundingBox();
  await p.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); await settle(p);
  assert.deepEqual(calls.filter(c => c[0] === 'button').map(c => c.slice(1)), [[0, true], [0, false]]);
  await p.click('#kbd'); await p.keyboard.insertText('héllo'); await settle(p);
  assert.ok(calls.some(c => c[0] === 'text' && c[1] === 'héllo'), JSON.stringify(calls.filter(c => c[0] === 'text')));
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
{
  const p = await open(`http://127.0.0.1:${config.port}`);
  await p.screenshot({ path: path.join(out, 'home.png') });
  await p.fill('#address', `127.0.0.1:${config.port}`); await p.fill('#password', 'wrong wrong wrong'); await p.click('#go');
  await p.waitForFunction(() => document.getElementById('status').textContent === 'Wrong password.', null, { timeout: 10000 }).then(() => console.log('wrong-password: ok'), () => { failed = true; console.log('wrong-password: FAILED'); });
}
await browser.close(); host.stop(); relay.stop();
if (failed) console.log(logs.join('\n'));
setTimeout(() => process.exit(failed ? 1 : 0), 500);
