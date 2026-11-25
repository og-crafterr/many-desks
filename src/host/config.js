import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { normalizePassword } from '../shared/secure.js';

export const dataDir = () => process.env.MANY_DESKS_DATA || path.join(os.homedir(), '.many-desks');
const file = () => path.join(dataDir(), 'config.json');

/** 17 characters from a 31-letter alphabet without look-alikes: about 84 bits. */
export function newPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  while (s.length < 17) s += letters[crypto.randomInt(letters.length)];
  return s.replace(/(.{4})(?=.)/g, '$1-');
}
export function checkPassword(p) {
  if (normalizePassword(p).length < 12) throw new Error('Use at least 12 characters (dashes and spaces are ignored).');
}
export function idOf(publicKeyPem) {
  const n = crypto.createHash('sha256').update(publicKeyPem).digest().readBigUInt64BE(0);
  return String(100_000_000_000n + (n % 900_000_000_000n));
}
export function load() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`Can't read ${file()}: ${e.message}`); }
  let changed = false;
  const def = (k, v) => { if (c[k] === undefined) { c[k] = typeof v === 'function' ? v() : v; changed = true; } };
  def('name', () => os.hostname());
  def('password', newPassword);
  def('salt', () => crypto.randomBytes(16).toString('base64'));
  def('port', 7878);
  def('lan', false);
  def('unattended', false);
  def('relay', null); // { url, token }
  def('stun', []); // e.g. ["stun:stun.example.com:3478"]
  def('p2p', true);
  def('sharedFolder', () => path.join(os.homedir(), 'Many-Desks'));
  if (!c.identity) {
    const k = crypto.generateKeyPairSync('ed25519');
    c.identity = { public: k.publicKey.export({ type: 'spki', format: 'pem' }), private: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    changed = true;
  }
  if (changed) save(c);
  c.id = idOf(c.identity.public);
  return c;
}
export function save(c) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const { id, ...rest } = c;
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rest, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
