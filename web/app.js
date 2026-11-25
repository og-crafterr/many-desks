import { viewerHello, viewerKeys, proof, equal, b64, unb64, Channel, concat, parseJson } from '/secure.js';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('ogdesk.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ogdesk.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const PRESETS = { low: { fps: 15, maxHeight: 720, bitrate: 1200 }, balanced: { fps: 30, maxHeight: 1080, bitrate: 6000 }, high: { fps: 60, maxHeight: 0, bitrate: 15000 } };
let info = {}, s = null;

// ---- start page ----
const digits = a => a.replace(/[\s-]/g, '');
const isId = a => /^\d{12}$/.test(digits(a));
const needsRelay = () => isId($('address').value) && info.kind !== 'relay';
function relayRow() { $('relayRow').hidden = !needsRelay(); $('relay').required = needsRelay(); }
$('address').addEventListener('input', relayRow);
$('relay').value = store.get('relay', '');

function target(address, relay) {
  const wsOf = u => u.replace(/^http/, 'ws').replace(/\/+$/, '');
  if (isId(address)) {
    const base = info.kind === 'relay' ? location.origin : relay;
    if (!/^https?:\/\//.test(base || '')) throw new Error('Enter the relay address, starting with https://');
    return `${wsOf(base)}/connect?id=${digits(address)}`;
  }
  const a = address.trim();
  if (/^https?:\/\//.test(a)) return wsOf(new URL(a).origin) + '/connect';
  const u = new URL('http://' + a);
  return `ws://${u.hostname}:${u.port || 7878}/connect`;
}
function showSaved() {
  const list = store.get('computers', []);
  $('saved').replaceChildren(...list.map(c => {
    const li = document.createElement('li'), open = document.createElement('button'), del = document.createElement('button'), small = document.createElement('small');
    open.textContent = c.name || c.address; small.textContent = c.address; open.append(small);
    open.onclick = () => {
      $('address').value = c.address; $('password').value = c.password || ''; $('remember').checked = !!c.password;
      if (c.relay) $('relay').value = c.relay;
      relayRow();
      if (c.password) $('form').requestSubmit(); else $('password').focus();
    };
    del.textContent = 'Forget'; del.setAttribute('aria-label', `Forget ${c.name || c.address}`);
    del.onclick = () => { store.set('computers', list.filter(x => x !== c)); showSaved(); };
    li.append(open, del);
    return li;
  }));
  if (!list.length) $('saved').textContent = 'Computers you connect to are listed here.';
}
function remember(name) {
  const address = $('address').value.trim(), list = store.get('computers', []).filter(c => c.address !== address);
  list.unshift({ name, address, relay: $('relay').value, password: $('remember').checked ? $('password').value : undefined });
  store.set('computers', list.slice(0, 30)); store.set('relay', $('relay').value);
}
function status(text, bad) { $('status').textContent = text; $('status').className = bad ? 'bad' : ''; }
$('form').addEventListener('submit', e => {
  e.preventDefault();
  if (s) return;
  try { start(target($('address').value, $('relay').value.trim()), $('password').value); } catch (err) { status(err.message, true); }
});

// ---- connection ----
function start(url, password) {
  if (location.protocol === 'https:' && url.startsWith('ws:')) throw new Error('A secure page can\'t reach that address. Open OG Desk on your own computer (http://127.0.0.1:7878) instead.');
  const ws = new WebSocket(url), hello = viewerHello();
  ws.binaryType = 'arraybuffer';
  const me = s = { ws, stage: 0, seq: -1, frames: 0, bytes: 0, transfers: new Map(), nextId: 1, timers: [] };
  $('go').disabled = true; status('Connecting…');
  const late = setTimeout(() => fail('No answer. Check the address, and that the computer is on and running OG Desk.'), 15000);
  function fail(message) { if (s === me) end(message, true); }
  ws.onopen = () => ws.send(JSON.stringify(hello.message));
  ws.onclose = () => fail(me.opened ? 'The connection ended.' : me.denied || 'Couldn\'t connect. Check the address, and that the computer is on and running OG Desk.');
  ws.onmessage = async e => {
    if (s !== me) return;
    try {
      if (typeof e.data !== 'string') { me.chan.receive(new Uint8Array(e.data)); return; }
      const m = JSON.parse(e.data);
      if (m.t === 'error') return fail(m.message);
      if (me.stage === 0) {
        me.stage = 1; status('Checking the password…');
        await new Promise(r => setTimeout(r, 20)); // let the page repaint before the slow part
        me.keys = viewerKeys(hello.state, m, password);
        ws.send(JSON.stringify({ t: 'proof', mac: b64(proof(me.keys.proofV, 'viewer')) }));
      } else if (me.stage === 1) {
        if (m.t !== 'proof' || !equal(unb64(m.mac), proof(me.keys.proofH, 'host'))) return fail('That computer couldn\'t prove it knows the password.');
        me.stage = 2; clearTimeout(late);
        me.chan = new Channel({ send: p => { if (ws.readyState === 1) ws.send(p); } }, me.keys.v2h, me.keys.h2v);
        me.chan.onmessage = b => onMessage(me, b);
      }
    } catch (err) { console.error(err); fail('The connection was damaged and has been closed.'); }
  };
  me.late = late;
}
const send = m => { if (s?.opened) s.chan.json(m); };

function end(message, bad) {
  const me = s; s = null;
  if (!me) return;
  clearTimeout(me.late); me.timers.forEach(clearInterval); me.ws.onclose = null; me.ws.close(); me.pc?.close();
  try { me.decoder?.close(); } catch { /* already closed */ }
  $('desk').hidden = true; $('home').hidden = false; $('filePanel').hidden = true; $('go').disabled = false; $('transfers').replaceChildren();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  status(message || '', bad); document.title = 'OG Desk';
}

function onMessage(me, b) {
  if (me !== s) return;
  if (b[0] === 1) return onFrame(me, b);
  if (b[0] === 3) return onDownloadChunk(me, b);
  if (b[0] !== 0) return;
  const m = parseJson(b);
  switch (m.t) {
    case 'waiting': status('Waiting for someone at that computer to allow it…'); break;
    case 'denied': me.denied = m.message; end(m.message, true); break;
    case 'open': opened(me, m); break;
    case 'video': onVideoConfig(me, m); break;
    case 'videoError': $('note').textContent = `The screen can't be captured: ${m.message}`; break;
    case 'pong': me.rtt = Math.round(performance.now() - m.at); break;
    case 'clip': onClip(m.text); break;
    case 'rtc': onRtc(me, m).catch(() => {}); break;
    case 'p2p': me.direct = m.on; break;
    case 'list': showRemote(m.items); break;
    case 'putReady': pump(me, m.id); break;
    case 'putAck': { const t = me.transfers.get(m.id); if (t) { t.credit++; pump(me, m.id); } break; }
    case 'putDone': transferText(me, m.id, `Sent ${m.name}`); me.transfers.delete(m.id); send({ t: 'list' }); break;
    case 'getReady': { const t = me.transfers.get(m.id); if (t) t.size = m.size; break; }
    case 'getDone': finishDownload(me, m.id); break;
    case 'fileError': transferText(me, m.id, m.message) || ($('note').textContent = m.message); me.transfers.delete(m.id); break;
  }
}
function opened(me, m) {
  me.opened = true; me.monitors = m.monitors;
  remember(m.name); showSaved(); status('');
  $('home').hidden = true; $('desk').hidden = false; $('title').textContent = m.name; document.title = `${m.name} – OG Desk`;
  $('monitor').hidden = m.monitors.length < 2;
  $('monitor').replaceChildren(...m.monitors.map((x, i) => new Option(`Screen ${i + 1} (${x.width}×${x.height})`, i)));
  $('note').textContent = 'Waiting for the first picture…';
  $('viewOnly').checked = false;
  // H.264 needs WebCodecs, which browsers allow only on https or this computer itself. JPEG works everywhere.
  me.codec = 'VideoDecoder' in window ? 'h264' : 'jpeg';
  send({ t: 'settings', clipboard: $('clip').checked });
  applySettings();
  me.timers.push(setInterval(() => {
    send({ t: 'ping', at: performance.now() });
    $('stats').textContent = `${me.frames} fps · ${(me.bytes / 125000).toFixed(1)} Mb/s · ${me.rtt ?? '–'} ms · ${me.direct ? 'direct' : me.ws.url.includes('id=') ? 'relay' : 'direct'}`;
    me.frames = 0; me.bytes = 0;
  }, 1000));
  if (m.p2p && me.ws.url.includes('id=') && window.RTCPeerConnection) startRtc(me, m.stun).catch(() => {});
  $('stage').focus();
}
function applySettings() {
  if (!s?.opened) return;
  const p = PRESETS[$('quality').value];
  send({ t: 'settings', ...p, ...(s.codec === 'jpeg' ? { fps: Math.min(p.fps, 20) } : {}), codec: s.codec, monitor: Number($('monitor').value || 0), restart: true });
}

// ---- picture ----
const canvas = $('screen'), paint = canvas.getContext('2d', { alpha: false, desynchronized: true });
function draw(me, image, w, h) {
  if (me === s) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    paint.drawImage(image, 0, 0); me.frames++; $('note').textContent = '';
  }
  image.close();
}
function onVideoConfig(me, m) {
  try { me.decoder?.close(); } catch { /* already closed */ }
  me.decoder = null;
  if (m.codec !== 'h264') return;
  const d = me.decoder = new VideoDecoder({
    output: f => draw(me, f, f.displayWidth, f.displayHeight),
    error: () => { if (me === s && me.decoder === d) { me.codec = 'jpeg'; me.decoder = null; applySettings(); } },
  });
  d.configure({ codec: m.codecString, description: unb64(m.description), optimizeForLatency: true });
}
function onFrame(me, b) {
  const seq = new DataView(b.buffer, b.byteOffset).getUint32(2), key = b[1] === 1, data = b.subarray(6);
  me.bytes += b.length;
  send({ t: 'ack' });
  if (seq <= me.seq) return; // a late one from before the path changed
  me.seq = seq;
  if (me.decoder) { if (me.decoder.state === 'configured') me.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: seq * 1000, data })); return; }
  if (me.codec !== 'jpeg') return;
  createImageBitmap(new Blob([data], { type: 'image/jpeg' })).then(i => {
    if (seq < (me.drawn || 0)) return i.close();
    me.drawn = seq; draw(me, i, i.width, i.height);
  }).catch(() => {});
}

// ---- direct path ----
async function startRtc(me, stun) {
  const pc = me.pc = new RTCPeerConnection({ iceServers: stun.map(urls => ({ urls })) });
  const dc = pc.createDataChannel('v', { ordered: true });
  dc.binaryType = 'arraybuffer';
  const chan = new Channel({ send: p => dc.send(p) }, me.keys.p2pV2h, me.keys.p2pH2v);
  chan.onmessage = b => { if (b[0] === 1) onMessage(me, b); else if (b[0] === 0) { const m = parseJson(b); if (m.t === 'video') onMessage(me, b); } };
  dc.onmessage = e => { try { chan.receive(new Uint8Array(e.data)); } catch { pc.close(); } };
  pc.onicecandidate = e => { if (e.candidate?.candidate) send({ t: 'rtc', candidate: e.candidate.candidate, mid: e.candidate.sdpMid }); };
  await pc.setLocalDescription(await pc.createOffer());
  send({ t: 'rtc', sdp: { type: 'offer', sdp: pc.localDescription.sdp } });
}
async function onRtc(me, m) {
  me.early ??= [];
  if (m.sdp) { await me.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp.sdp }); for (const c of me.early.splice(0)) await me.pc.addIceCandidate(c).catch(() => {}); }
  else if (m.candidate) { const c = { candidate: m.candidate, sdpMid: m.mid }; if (me.pc.remoteDescription) await me.pc.addIceCandidate(c).catch(() => {}); else me.early.push(c); }
}

// ---- mouse, touch and keyboard ----
const stage = $('stage'), typing = $('typing');
function at(e) {
  const r = canvas.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
const BUTTONS = [0, 1, 2, 3, 4];
let moveTo = null;
function queueMove(p) {
  if (!moveTo) requestAnimationFrame(() => { if (moveTo) send({ t: 'move', ...moveTo }); moveTo = null; });
  moveTo = p;
}
// Pointer buttons use 0 left, 1 middle, 2 right; the host expects 0 left, 1 middle, 2 right too.
const touches = new Map();
let touch = null;
canvas.addEventListener('pointerdown', e => {
  e.preventDefault(); canvas.setPointerCapture(e.pointerId); if (document.activeElement !== typing) stage.focus();
  if (e.pointerType === 'touch') return touchDown(e);
  moveTo = null; send({ t: 'button', b: BUTTONS[e.button] ?? 0, down: true, ...at(e) });
});
canvas.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch') return touchMove(e);
  // Extra buttons pressed while one is held arrive as moves.
  if (e.button > 0 && e.button < 5 && e.buttons) send({ t: 'button', b: e.button, down: !!(e.buttons & [1, 4, 2, 8, 16][e.button]), ...at(e) });
  else queueMove(at(e));
});
canvas.addEventListener('pointerup', e => {
  if (e.pointerType === 'touch') return touchUp(e);
  moveTo = null; send({ t: 'button', b: BUTTONS[e.button] ?? 0, down: false, ...at(e) });
});
canvas.addEventListener('pointercancel', e => { touches.delete(e.pointerId); if (touch) clearTimeout(touch.timer); touch = null; send({ t: 'releaseAll' }); });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1.2;
  send({ t: 'wheel', dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k) });
}, { passive: false });
// Touch: tap clicks, hold right-clicks, drag moves the pointer, tap then drag holds the button, two fingers scroll.
let lastTap = 0;
function touchDown(e) {
  touches.set(e.pointerId, e);
  if (touches.size === 2) { if (touch) { clearTimeout(touch.timer); if (touch.drag) send({ t: 'button', b: 0, down: false }); } touch = { scroll: true, y: e.clientY, x: e.clientX, id: e.pointerId }; return; }
  if (touches.size > 2) return;
  const p = at(e);
  touch = { x: e.clientX, y: e.clientY, drag: Date.now() - lastTap < 300 };
  if (touch.drag) send({ t: 'button', b: 0, down: true, ...p });
  else {
    send({ t: 'move', ...p });
    const mine = touch;
    touch.timer = setTimeout(() => { if (touch === mine && !mine.moved) { mine.done = true; send({ t: 'button', b: 2, down: true, ...p }); send({ t: 'button', b: 2, down: false }); navigator.vibrate?.(20); } }, 550);
  }
}
function touchMove(e) {
  if (!touch) return;
  if (touch.scroll) {
    if (e.pointerId !== touch.id) return;
    send({ t: 'wheel', dx: Math.round((touch.x - e.clientX) * 4), dy: Math.round((touch.y - e.clientY) * 4) });
    touch.x = e.clientX; touch.y = e.clientY; return;
  }
  if (!touch.moved && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) < 8) return;
  touch.moved = true; clearTimeout(touch.timer); queueMove(at(e));
}
function touchUp(e) {
  touches.delete(e.pointerId);
  if (!touch) return;
  clearTimeout(touch.timer);
  if (touch.drag) { moveTo = null; send({ t: 'button', b: 0, down: false, ...at(e) }); }
  else if (!touch.scroll && !touch.moved && !touch.done) { send({ t: 'button', b: 0, down: true, ...at(e) }); send({ t: 'button', b: 0, down: false }); lastTap = Date.now(); }
  if (!touches.size) touch = null;
}

stage.addEventListener('keydown', e => {
  if (!e.code || e.isComposing) return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV' && $('clip').checked && !e.repeat) {
    e.preventDefault();
    pasteClipboard().finally(() => send({ t: 'key', code: 'KeyV', down: true }));
    return;
  }
  e.preventDefault();
  send({ t: 'key', code: e.code, down: true });
});
stage.addEventListener('keyup', e => { if (e.code) { e.preventDefault(); if (e.code === 'KeyV') setTimeout(() => send({ t: 'key', code: 'KeyV', down: false }), 150); else send({ t: 'key', code: e.code, down: false }); } });
const release = () => { send({ t: 'releaseAll' }); document.querySelectorAll('#extra .on').forEach(b => b.classList.remove('on')); };
stage.addEventListener('blur', release);
addEventListener('blur', release);
// The on-screen keyboard reports text, not keys.
typing.addEventListener('input', () => {
  const v = typing.value; typing.value = '·';
  if (v === '') press('Backspace'); else send({ t: 'text', text: v.replace('·', '') });
});
typing.addEventListener('keydown', e => { if (['Enter', 'Tab', 'Escape'].includes(e.key)) { e.preventDefault(); press(e.key); } });
$('kbd').onclick = () => { typing.value = '·'; typing.focus(); };
function press(...codes) { for (const c of codes) send({ t: 'key', code: c, down: true }); for (const c of codes.reverse()) send({ t: 'key', code: c, down: false }); }
for (const [label, ...codes] of [['Esc', 'Escape'], ['Tab', 'Tab'], ['Win', 'MetaLeft'], ['Alt+Tab', 'AltLeft', 'Tab'], ['Alt+F4', 'AltLeft', 'F4'], ['Task Manager', 'ControlLeft', 'ShiftLeft', 'Escape'], ['Copy', 'ControlLeft', 'KeyC'], ['Paste', 'ControlLeft', 'KeyV'], ['Del', 'Delete'], ['←', 'ArrowLeft'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight']]) {
  const b = document.createElement('button'); b.textContent = label; b.onclick = () => press(...codes); $('extra').append(b);
}
for (const [label, code] of [['Ctrl', 'ControlLeft'], ['Alt', 'AltLeft'], ['Shift', 'ShiftLeft']]) {
  const b = document.createElement('button'); b.textContent = label;
  b.onclick = () => send({ t: 'key', code, down: b.classList.toggle('on') });
  $('extra').prepend(b);
}
{ const b = document.createElement('button'); b.textContent = 'Lock computer'; b.onclick = () => send({ t: 'lock' }); $('extra').append(b); }
// Pressing a button on the bars shouldn't take the keyboard away from the remote screen.
for (const id of ['extra']) $(id).addEventListener('pointerdown', e => e.preventDefault());

// ---- toolbar ----
$('keys').onclick = () => { $('extra').hidden = !$('extra').hidden; };
$('leave').onclick = () => { send({ t: 'bye' }); end(''); };
$('quality').onchange = applySettings; $('monitor').onchange = applySettings;
$('scale').onchange = () => stage.classList.toggle('actual', $('scale').value === 'actual');
$('viewOnly').onchange = () => send({ t: 'settings', viewOnly: $('viewOnly').checked });
$('clip').onchange = () => send({ t: 'settings', clipboard: $('clip').checked });
$('full').onclick = async () => { try { await $('desk').requestFullscreen(); await navigator.keyboard?.lock?.(); } catch { /* not allowed here */ } stage.focus(); };

// ---- clipboard (browsers allow it only on https or this computer itself) ----
let lastClip = '';
async function onClip(text) {
  if (!$('clip').checked) return;
  lastClip = text;
  try { await navigator.clipboard.writeText(text); } catch { /* not allowed on this page */ }
}
async function pasteClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text !== lastClip) { lastClip = text; send({ t: 'clip', text }); await new Promise(r => setTimeout(r, 120)); }
  } catch { /* not allowed on this page */ }
}

// ---- files ----
$('files').onclick = () => { $('filePanel').hidden = false; send({ t: 'list' }); };
$('closeFiles').onclick = () => { $('filePanel').hidden = true; stage.focus(); };
$('refresh').onclick = () => send({ t: 'list' });
const size = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1e3) + ' KB';
function showRemote(items) {
  $('remote').replaceChildren(...items.map(f => {
    const li = document.createElement('li'), b = document.createElement('button');
    b.textContent = `${f.name} (${size(f.size)})`;
    b.onclick = () => {
      if (f.size > 1.5e9) { $('note').textContent = 'Files over 1.5 GB can\'t be downloaded in a browser.'; return; }
      const id = s.nextId++; s.transfers.set(id, { name: f.name, parts: [], got: 0, li: addTransfer(`Getting ${f.name}`) }); send({ t: 'get', id, name: f.name });
    };
    li.append(b); return li;
  }));
}
function addTransfer(text) { const li = document.createElement('li'); li.textContent = text; $('transfers').prepend(li); return li; }
function transferText(me, id, text) { const t = me.transfers.get(id); if (t) t.li.textContent = text; return !!t; }
function upload(files) {
  if (!s?.opened) return;
  $('filePanel').hidden = false;
  for (const file of files) { const id = s.nextId++; s.transfers.set(id, { file, at: 0, credit: 16, li: addTransfer(`Sending ${file.name}`) }); send({ t: 'put', id, name: file.name, size: file.size }); }
}
async function pump(me, id) {
  const t = me.transfers.get(id);
  if (!t?.file || t.busy || t.sentAll) return;
  t.busy = true;
  const head = new Uint8Array(5); head[0] = 2; new DataView(head.buffer).setUint32(1, id);
  try {
    while (t.credit > 0 && !t.sentAll && me === s && me.transfers.has(id)) {
      const piece = new Uint8Array(await t.file.slice(t.at, t.at + 55000).arrayBuffer());
      if (me !== s) return;
      t.at += piece.length; t.credit--; me.chan.send(concat(head, piece));
      t.sentAll = t.at >= t.file.size;
      t.li.textContent = `Sending ${t.file.name}: ${Math.floor(100 * t.at / (t.file.size || 1))}%`;
    }
  } catch { t.li.textContent = `Couldn't read ${t.file.name}`; me.transfers.delete(id); }
  t.busy = false;
}
function onDownloadChunk(me, b) {
  const id = new DataView(b.buffer, b.byteOffset).getUint32(1), t = me.transfers.get(id);
  if (!t) return;
  t.parts.push(b.slice(5)); t.got += b.length - 5; send({ t: 'getAck', id });
  t.li.textContent = `Getting ${t.name}: ${Math.floor(100 * t.got / (t.size || 1))}%`;
}
function finishDownload(me, id) {
  const t = me.transfers.get(id);
  if (!t) return;
  me.transfers.delete(id);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(t.parts)); a.download = t.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  t.li.textContent = `Got ${t.name}`;
}
$('upload').onchange = e => { upload([...e.target.files]); e.target.value = ''; };
stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('drop'); });
stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
stage.addEventListener('drop', e => { e.preventDefault(); stage.classList.remove('drop'); upload([...e.dataTransfer.files]); });

info = await fetch('/info').then(r => r.json()).catch(() => ({}));
showSaved(); relayRow();
