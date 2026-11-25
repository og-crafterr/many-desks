#!/usr/bin/env node
import crypto from 'node:crypto';
import { load, save, newPassword, checkPassword, dataDir } from '../src/host/config.js';

const [cmd = 'help', ...args] = process.argv.slice(2);
const pretty = id => id.replace(/(\d{3})(?=\d)/g, '$1 ');
const onOff = v => { if (v !== 'on' && v !== 'off') throw new Error('Say "on" or "off".'); return v === 'on'; };
const RESTART = 'If Many Desks is running, restart it to use this.';

function show(c) {
  console.log(`Name        ${c.name}
Address     ${pretty(c.id)}${c.relay ? `  (through ${c.relay.url})` : '  (only used with a relay)'}
Password    ${c.password}
Port        ${c.port}
Home network ${c.lan ? 'on' : 'off'}
Unattended  ${c.unattended ? 'on: no question is asked' : 'off: someone here must allow each connection'}
Direct path ${c.p2p ? 'on' : 'off'}${c.stun.length ? `, STUN ${c.stun.join(', ')}` : ', no STUN server'}
Files       ${c.sharedFolder}
Settings    ${dataDir()}`);
}
const COMMANDS = {
  async host() {
    const { startHost } = await import('../src/host/index.js');
    const c = load();
    show(c); console.log('');
    const h = await startHost(c);
    console.log(`\nOpen http://127.0.0.1:${h.port} to connect to another computer. Ctrl+C stops Many Desks.`);
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { h.stop(); setTimeout(() => process.exit(0), 300); });
  },
  async relay() {
    const { startRelay } = await import('../src/relay/index.js');
    const token = process.env.MANY_DESKS_RELAY_TOKEN;
    if (!token) throw new Error(`Set MANY_DESKS_RELAY_TOKEN first. Here's a new one: ${crypto.randomBytes(24).toString('base64url')}`);
    await startRelay({ token, port: Number(process.env.PORT || 7879), address: process.env.MANY_DESKS_BIND || '127.0.0.1', trustProxy: process.env.MANY_DESKS_TRUST_PROXY === '1' });
  },
  info() { show(load()); },
  password() {
    const c = load();
    if (args[0] && args[0] !== 'new') { checkPassword(args.join(' ')); c.password = args.join(' '); } else c.password = newPassword();
    c.salt = crypto.randomBytes(16).toString('base64');
    save(c); console.log(`Password: ${c.password}\n${RESTART}`);
  },
  unattended() { const c = load(); c.unattended = onOff(args[0]); save(c); console.log(`Unattended access is ${args[0]}. ${RESTART}`); },
  lan() { const c = load(); c.lan = onOff(args[0]); save(c); console.log(`Home-network access is ${args[0]}. ${RESTART}`); },
  p2p() { const c = load(); c.p2p = onOff(args[0]); save(c); console.log(`Direct connections are ${args[0]}. ${RESTART}`); },
  stun() { const c = load(); c.stun = args; save(c); console.log(`STUN servers: ${args.join(', ') || 'none'}. ${RESTART}`); },
  name() { const c = load(); if (!args[0]) throw new Error('Give a name.'); c.name = args.join(' ').slice(0, 60); save(c); console.log(`Name: ${c.name}. ${RESTART}`); },
  'use-relay'() {
    const c = load();
    if (args[0] === 'off') c.relay = null;
    else {
      const u = new URL(args[0] || ''), local = ['localhost', '127.0.0.1'].includes(u.hostname);
      if (!args[1]) throw new Error('Usage: many-desks use-relay https://relay.example.com <token>');
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('The relay address must start with https://');
      c.relay = { url: u.origin, token: args[1] };
    }
    save(c); console.log(`Relay: ${c.relay?.url || 'off'}. ${RESTART}`);
  },
  help() {
    console.log(`Many Desks by OGCraft: remote desktop for your own devices

  many-desks host                      share this computer, and open the viewer
  many-desks info                      show this computer's address and password
  many-desks password [new | <words>]  make or set the password
  many-desks unattended on|off         allow connections without asking here
  many-desks lan on|off                accept connections from the home network
  many-desks use-relay <url> <token>   be reachable over the internet ("off" stops)
  many-desks p2p on|off                try a direct path as well as the relay
  many-desks stun [stun:host:port ...] STUN servers that help find a direct path
  many-desks name <name>               rename this computer
  many-desks relay                     run a relay (needs MANY_DESKS_RELAY_TOKEN)`);
  },
};
try {
  if (!Object.hasOwn(COMMANDS, cmd)) { COMMANDS.help(); process.exitCode = 1; } else await COMMANDS[cmd]();
} catch (e) { console.error(e.message); process.exitCode = 1; }
