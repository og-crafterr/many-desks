import koffi from 'koffi';
import KEYS from './keys.js';

const u = koffi.load('user32.dll'), k = koffi.load('kernel32.dll');
const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT }) });
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });
koffi.struct('POINT', { x: 'long', y: 'long' });
koffi.proto('bool __stdcall EnumProc(void* mon, void* dc, void* r, intptr_t data)');
const SendInput = u.func('uint32 __stdcall SendInput(uint32 n, INPUT* p, int size)');
const GetSystemMetrics = u.func('int __stdcall GetSystemMetrics(int i)');
const EnumDisplayMonitors = u.func('bool __stdcall EnumDisplayMonitors(void* dc, void* clip, EnumProc* cb, intptr_t data)');
const GetMonitorInfo = u.func('bool __stdcall GetMonitorInfoW(void* mon, _Inout_ MONITORINFO* info)');
const GetCursorPos = u.func('bool __stdcall GetCursorPos(_Out_ POINT* p)');
const MessageBoxTimeout = u.func('int __stdcall MessageBoxTimeoutW(void* hwnd, str16 text, str16 title, uint32 flags, uint16 lang, uint32 ms)');
const OpenClipboard = u.func('bool __stdcall OpenClipboard(void* h)'), CloseClipboard = u.func('bool __stdcall CloseClipboard()');
const EmptyClipboard = u.func('bool __stdcall EmptyClipboard()');
const GetClipboardData = u.func('void* __stdcall GetClipboardData(uint32 f)'), SetClipboardData = u.func('void* __stdcall SetClipboardData(uint32 f, void* h)');
const GetClipboardSequenceNumber = u.func('uint32 __stdcall GetClipboardSequenceNumber()');
const LockWorkStation = u.func('bool __stdcall LockWorkStation()');
const GlobalAlloc = k.func('void* __stdcall GlobalAlloc(uint32 f, size_t n)'), GlobalLock = k.func('void* __stdcall GlobalLock(void* h)');
const GlobalUnlock = k.func('bool __stdcall GlobalUnlock(void* h)'), GlobalSize = k.func('size_t __stdcall GlobalSize(void* h)');
try { u.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t v)')(-4); } catch { /* older Windows */ }

const SIZE = koffi.sizeof(INPUT);
const mouse = (dx, dy, mouseData, dwFlags) => SendInput(1, [{ type: 0, u: { mi: { dx, dy, mouseData: mouseData >>> 0, dwFlags, time: 0, dwExtraInfo: 0 } } }], SIZE) === 1;
const key = (wScan, dwFlags) => SendInput(1, [{ type: 1, u: { ki: { wVk: 0, wScan, dwFlags, time: 0, dwExtraInfo: 0 } } }], SIZE) === 1;
const DOWN = [0x2, 0x20, 0x8, 0x80, 0x80], UP = [0x4, 0x40, 0x10, 0x100, 0x100];

export function monitors() {
  const out = [];
  const zero = () => ({ left: 0, top: 0, right: 0, bottom: 0 });
  EnumDisplayMonitors(null, null, mon => {
    const i = { cbSize: 40, rcMonitor: zero(), rcWork: zero(), dwFlags: 0 };
    if (GetMonitorInfo(mon, i)) {
      const r = i.rcMonitor;
      out.push({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, primary: (i.dwFlags & 1) === 1 });
    }
    return true;
  }, 0);
  return out.sort((a, b) => b.primary - a.primary || a.x - b.x);
}
export const input = {
  /** x and y are virtual-desktop pixels. */
  move(x, y) {
    const vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    return mouse(Math.ceil((x - vx) * 65536 / vw), Math.ceil((y - vy) * 65536 / vh), 0, 0x8000 | 0x4000 | 0x1);
  },
  button(b, down) { return mouse(0, 0, b === 3 ? 1 : b === 4 ? 2 : 0, (down ? DOWN : UP)[b]); },
  wheel(dx, dy) { if (dy) mouse(0, 0, Math.round(-dy), 0x800); if (dx) mouse(0, 0, Math.round(dx), 0x1000); },
  key(code, down) { const s = KEYS[code]; if (s) key(s[0] & 0xff, 0x8 | (s[0] & 0x100 ? 1 : 0) | (down ? 0 : 2)); },
  text(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 10) { key(0x1c, 8); key(0x1c, 10); } else { key(c, 4); key(c, 6); }
    }
  },
  position() { const p = {}; GetCursorPos(p); return p; },
};
async function openClipboard() {
  for (let i = 0; i < 8; i++) { if (OpenClipboard(null)) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
}
export const clipboard = {
  version: async () => GetClipboardSequenceNumber(),
  async read() {
    if (!await openClipboard()) return null;
    try {
      const h = GetClipboardData(13);
      if (!h) return null;
      const size = Number(GlobalSize(h)), p = GlobalLock(h);
      if (!p) return null;
      try { return Buffer.from(koffi.view(p, size)).toString('utf16le').split('\0')[0]; } finally { GlobalUnlock(h); }
    } finally { CloseClipboard(); }
  },
  async write(text) {
    const bytes = Buffer.from(text + '\0', 'utf16le');
    if (!await openClipboard()) return false;
    try {
      const h = GlobalAlloc(2, bytes.length), p = GlobalLock(h);
      new Uint8Array(koffi.view(p, bytes.length)).set(bytes);
      GlobalUnlock(h);
      EmptyClipboard();
      return !!SetClipboardData(13, h);
    } finally { CloseClipboard(); }
  },
};
/** Asks the person at this computer. No answer in 30 seconds means no. */
export const ask = text => new Promise(r => MessageBoxTimeout.async(null, text, 'OG Desk', 0x4 | 0x20 | 0x100 | 0x1000 | 0x10000 | 0x40000, 0, 30000, (e, v) => r(!e && v === 6)));
export const lock = () => LockWorkStation();
