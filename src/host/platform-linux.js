// Linux under X11: needs xdotool, xrandr, xclip and zenity. Wayland sessions aren't supported.
import { spawn, execFile } from 'node:child_process';
import KEYS from './keys.js';

const run = (cmd, args, stdin) => new Promise(r => {
  const p = execFile(cmd, args, { timeout: 35000, maxBuffer: 8e6 }, (e, out) => r(e ? null : out));
  p.stdin.on('error', () => {});
  p.stdin.end(stdin);
});
export async function monitors() {
  const out = await run('xrandr', ['--query']) || '', list = [];
  for (const m of out.matchAll(/ connected (primary )?(\d+)x(\d+)\+(\d+)\+(\d+)/g)) list.push({ x: +m[4], y: +m[5], width: +m[2], height: +m[3], primary: !!m[1] });
  return list.sort((a, b) => b.primary - a.primary || a.x - b.x);
}
let xd;
function x(line) {
  if (!xd) {
    xd = spawn('xdotool', ['-'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const gone = () => { xd = null; };
    xd.on('error', gone); xd.on('exit', gone); xd.stdin.on('error', gone);
  }
  xd.stdin.write(line + '\n');
}
const BUTTON = [1, 2, 3, 8, 9];
let ax = 0, ay = 0;
function clicks(v, negative, positive) {
  const n = Math.min(20, Math.trunc(Math.abs(v) / 100));
  for (let i = 0; i < n; i++) x(`click ${v < 0 ? negative : positive}`);
  return Math.sign(v) * n * 100;
}
export const input = {
  move(px, py) { x(`mousemove ${Math.round(px)} ${Math.round(py)}`); },
  button(b, down) { x(`${down ? 'mousedown' : 'mouseup'} ${BUTTON[b]}`); },
  wheel(dx, dy) { ax += dx; ay += dy; ay -= clicks(ay, 4, 5); ax -= clicks(ax, 6, 7); },
  key(code, down) { const s = KEYS[code]; if (s) x(`${down ? 'keydown' : 'keyup'} ${s[1]}`); },
  text(s) { run('xdotool', ['type', '--clearmodifiers', '--file', '-'], s); },
};
let last = null, version = 0;
export const clipboard = {
  async version() {
    const t = await this.read();
    if (t !== last) { last = t; version++; }
    return version;
  },
  read: () => run('xclip', ['-selection', 'clipboard', '-o']),
  async write(text) {
    const p = spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {}); p.stdin.on('error', () => {});
    p.stdin.end(text);
    return true;
  },
};
export const ask = async text => (await run('zenity', ['--question', '--title=Many Desks', '--timeout=30', '--default-cancel', '--text=' + text.replace(/[<&]/g, '')])) !== null;
export const lock = () => run('loginctl', ['lock-session']);
