// End-to-end encryption shared by the host (Node) and the viewer (browser). Pure JavaScript, so it
// also works on plain-http pages where crypto.subtle is missing.
//
// X25519 ephemeral exchange + a scrypt-stretched password mixed into every key. Someone in the middle
// (a relay, say) who does not know the password cannot complete it and cannot read the traffic.
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scrypt } from '@noble/hashes/scrypt.js';

const enc = new TextEncoder(), dec = new TextDecoder();
export const VERSION = 1;
export const FRAGMENT = 60_000;
export const MAX_MESSAGE = 32 * 1024 * 1024;

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export const random = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
export function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function unb64(text) {
  return Uint8Array.from(atob(String(text)), c => c.charCodeAt(0));
}
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
/** Dashes, spaces and case do not matter, so generated passwords are easy to type on a phone. */
export const normalizePassword = p => String(p).normalize('NFKC').replace(/[\s-]/g, '').toLowerCase();
export const stretch = (password, salt) => scrypt(enc.encode(normalizePassword(password)), salt, { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });

function nonce(counter) {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(counter));
  return n;
}

/** One ordered, reliable, encrypted message stream over a transport. Large messages are fragmented. */
export class Channel {
  constructor(transport, sendKey, recvKey) {
    this.transport = transport; this.sendKey = sendKey; this.recvKey = recvKey;
    this.out = 0; this.in = 0; this.parts = []; this.size = 0;
    this.onmessage = () => {};
  }
  send(bytes) {
    for (let at = 0; ; at += FRAGMENT) {
      const piece = bytes.subarray(at, at + FRAGMENT), more = at + FRAGMENT < bytes.length;
      const plain = new Uint8Array(piece.length + 1);
      plain[0] = more ? 1 : 0; plain.set(piece, 1);
      this.transport.send(chacha20poly1305(this.sendKey, nonce(this.out++)).encrypt(plain));
      if (!more) return;
    }
  }
  json(value) { this.send(concat(Uint8Array.of(0), enc.encode(JSON.stringify(value)))); }
  /** Throws on a forged, replayed or reordered packet: the caller must close. */
  receive(packet) {
    const plain = chacha20poly1305(this.recvKey, nonce(this.in++)).decrypt(packet);
    if (plain.length < 1) throw new Error('empty packet');
    this.size += plain.length;
    if (this.size > MAX_MESSAGE) throw new Error('message too big');
    this.parts.push(plain.subarray(1));
    if (plain[0] === 1) return;
    const whole = this.parts.length === 1 ? this.parts[0] : concat(...this.parts);
    this.parts = []; this.size = 0;
    if (whole.length) this.onmessage(whole);
  }
}
export const parseJson = bytes => JSON.parse(dec.decode(bytes.subarray(1)));

function deriveKeys(shared, psk, transcript) {
  const okm = hkdf(sha256, concat(shared, psk), sha256(transcript), enc.encode('og-desk v1'), 192);
  const k = i => okm.slice(i * 32, i * 32 + 32);
  return { v2h: k(0), h2v: k(1), proofV: k(2), proofH: k(3), p2pV2h: k(4), p2pH2v: k(5) };
}
const transcriptOf = (vpub, vn, hpub, hn, salt) => concat(enc.encode('og-desk'), Uint8Array.of(VERSION), vpub, vn, hpub, hn, salt);
const field = (value, n) => {
  const b = unb64(value);
  if (b.length !== n) throw new Error('bad handshake');
  return b;
};

export function viewerHello() {
  const secret = x25519.utils.randomSecretKey(), pub = x25519.getPublicKey(secret), n = random(32);
  return { state: { secret, pub, n }, message: { t: 'hello', v: VERSION, pub: b64(pub), n: b64(n) } };
}
export function hostReply(hello, salt, psk) {
  if (hello?.t !== 'hello' || hello.v !== VERSION) throw new Error('bad handshake');
  const vpub = field(hello.pub, 32), vn = field(hello.n, 32);
  const secret = x25519.utils.randomSecretKey(), pub = x25519.getPublicKey(secret), n = random(32);
  const keys = deriveKeys(x25519.getSharedSecret(secret, vpub), psk, transcriptOf(vpub, vn, pub, n, salt));
  return { keys, message: { t: 'hello', v: VERSION, pub: b64(pub), n: b64(n), salt: b64(salt) } };
}
export function viewerKeys(state, reply, password) {
  if (reply?.t !== 'hello' || reply.v !== VERSION) throw new Error('bad handshake');
  const hpub = field(reply.pub, 32), hn = field(reply.n, 32), salt = field(reply.salt, 16);
  return deriveKeys(x25519.getSharedSecret(state.secret, hpub), stretch(password, salt), transcriptOf(state.pub, state.n, hpub, hn, salt));
}
export const proof = (key, who) => hmac(sha256, key, enc.encode(who));
