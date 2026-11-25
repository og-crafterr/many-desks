// Screen capture: one ffmpeg per session, turned into H.264 packets or JPEG pictures.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** Splits ffmpeg's FLV output into H.264 packets. FLV gives exact sizes, so nothing waits for the next frame. */
export class FlvParser {
  constructor(onPacket) { this.buf = Buffer.alloc(0); this.started = false; this.onPacket = onPacket; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.started) {
      if (this.buf.length < 13) return;
      if (this.buf.toString('latin1', 0, 3) !== 'FLV') throw new Error('not FLV');
      this.buf = this.buf.subarray(this.buf.readUInt32BE(5) + 4);
      this.started = true;
    }
    while (this.buf.length >= 15) {
      const size = this.buf.readUIntBE(1, 3), total = 11 + size + 4;
      if (this.buf.length < total) return;
      const type = this.buf[0], body = this.buf.subarray(11, 11 + size);
      if (type === 9 && size >= 5 && (body[0] & 15) === 7) {
        if (body[1] === 0) this.onPacket({ config: body.subarray(5) });
        else if (body[1] === 1 && size > 5) this.onPacket({ key: body[0] >> 4 === 1, data: body.subarray(5) });
      }
      this.buf = this.buf.subarray(total);
    }
  }
}
/** Splits an MJPEG stream. FF D9 can't appear inside JPEG entropy data. */
export class JpegParser {
  constructor(onPacket) { this.buf = Buffer.alloc(0); this.onPacket = onPacket; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const end = this.buf.indexOf(Buffer.from([0xff, 0xd9]));
      if (end < 0) { if (this.buf.length > 32e6) throw new Error('bad JPEG stream'); return; }
      this.onPacket({ key: true, data: this.buf.subarray(0, end + 2) });
      this.buf = this.buf.subarray(end + 2);
    }
  }
}
export const codecString = avcC => 'avc1.' + [1, 2, 3].map(i => avcC[i].toString(16).padStart(2, '0')).join('');

let encoderPromise;
/** The first H.264 encoder that really works on this computer. */
export function findEncoder() {
  return encoderPromise ??= (async () => {
    for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']) {
      const ok = await new Promise(r => {
        const p = spawn('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=30', '-frames:v', '3', '-pix_fmt', e === 'h264_qsv' ? 'nv12' : 'yuv420p', '-c:v', e, '-f', 'null', '-'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
        p.on('error', () => r(false)); p.on('exit', c => r(c === 0));
      });
      if (ok) return e;
    }
    throw new Error('ffmpeg with an H.264 encoder was not found');
  })();
}
const ENCODER_OPTIONS = {
  h264_nvenc: ['-preset', 'p1', '-tune', 'ull', '-rc', 'cbr', '-zerolatency', '1', '-delay', '0'],
  h264_qsv: ['-preset', 'veryfast', '-async_depth', '1'],
  h264_amf: ['-usage', 'ultralowlatency'],
  libx264: ['-preset', 'ultrafast', '-tune', 'zerolatency'],
};
export function buildArgs({ platform, monitor, single, fps, maxHeight, codec, bitrate, encoder, grabber, display }) {
  const a = ['-hide_banner', '-v', 'error', '-nostdin', '-fflags', 'nobuffer'], vf = [];
  if (platform === 'test') a.push('-re', '-f', 'lavfi', '-i', `testsrc2=s=${monitor.width}x${monitor.height}:r=${fps}`);
  else if (platform === 'win32' && grabber === 'dda' && single) {
    a.push('-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${fps}`);
    vf.push('hwdownload', 'format=bgra');
  } else if (platform === 'win32') {
    a.push('-f', 'gdigrab', '-framerate', String(fps), '-offset_x', String(monitor.x), '-offset_y', String(monitor.y), '-video_size', `${monitor.width}x${monitor.height}`, '-i', 'desktop');
  } else {
    a.push('-f', 'x11grab', '-framerate', String(fps), '-video_size', `${monitor.width}x${monitor.height}`, '-i', `${display}+${monitor.x},${monitor.y}`);
  }
  if (maxHeight && maxHeight < monitor.height) vf.push(`scale=-2:${maxHeight}:flags=fast_bilinear`);
  else vf.push('crop=trunc(iw/2)*2:trunc(ih/2)*2');
  vf.push(codec === 'jpeg' ? 'format=yuvj420p' : encoder === 'h264_qsv' ? 'format=nv12' : 'format=yuv420p');
  a.push('-an', '-vf', vf.join(','));
  if (codec === 'jpeg') a.push('-c:v', 'mjpeg', '-q:v', '7', '-flush_packets', '1', '-f', 'mjpeg', 'pipe:1');
  else {
    a.push('-c:v', encoder, ...ENCODER_OPTIONS[encoder], '-profile:v', encoder === 'libx264' ? 'baseline' : 'main', '-bf', '0', '-g', String(fps * 2),
      '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${Math.round(bitrate / 4)}k`, '-flush_packets', '1', '-flvflags', 'no_duration_filesize', '-f', 'flv', 'pipe:1');
  }
  return a;
}

/** Emits 'config' (avcC), 'packet' ({key, data}) and 'failed' (message). Restarts ffmpeg when it stops. */
export class Capture extends EventEmitter {
  constructor(options) { super(); this.o = options; this.stopped = false; this.fails = 0; this.grabber = 'dda'; }
  async start() {
    if (this.stopped) return;
    let encoder = null;
    try { if (this.o.codec !== 'jpeg') encoder = await findEncoder(); }
    catch (e) { this.emit('failed', e.message); return; }
    if (this.stopped) return;
    const args = buildArgs({ platform: process.platform, display: process.env.DISPLAY || ':0', ...this.o, encoder, grabber: this.grabber });
    const p = this.p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '', got = false;
    const on = k => {
      got = true; this.fails = 0;
      if (k.config) this.emit('config', Buffer.from(k.config));
      else this.emit('packet', { key: k.key, data: Buffer.from(k.data) });
    };
    const parser = this.o.codec === 'jpeg' ? new JpegParser(on) : new FlvParser(on);
    p.stdout.on('data', d => {
      if (this.p !== p || this.stopped) return;
      try { parser.push(d); } catch (e) { err += e.message; p.kill(); }
    });
    p.stderr.on('data', d => { err = (err + d).slice(-800); });
    p.on('error', e => { err += e.message; });
    p.on('close', () => {
      if (this.stopped || this.p !== p) return;
      this.grabber = got ? 'dda' : this.grabber === 'dda' ? 'gdi' : 'dda';
      if (++this.fails > 8) { this.emit('failed', err.trim() || 'screen capture stopped'); return; }
      this.timer = setTimeout(() => this.start(), Math.min(4000, 200 * 2 ** this.fails));
    });
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.p?.kill('SIGKILL'); this.removeAllListeners(); }
}
