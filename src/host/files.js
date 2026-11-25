// File transfer is limited to one shared folder: plain names only, never overwriting, never through links.
import fs from 'node:fs/promises';
import path from 'node:path';

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i;
export function safeName(name) {
  const n = path.posix.basename(String(name).replaceAll('\\', '/')).replace(/[<>:"/|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 180);
  if (!n || n === '.' || n === '..') throw new Error('That file name can\'t be used.');
  return RESERVED.test(n) ? '_' + n : n;
}
export async function listShared(dir) {
  await fs.mkdir(dir, { recursive: true });
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.endsWith('.part')) continue;
    out.push({ name: e.name, size: (await fs.stat(path.join(dir, e.name))).size });
  }
  return out.slice(0, 1000);
}
export async function openShared(dir, name) {
  if (safeName(name) !== name) throw new Error('That file name can\'t be used.');
  const file = path.join(dir, name), st = await fs.lstat(file).catch(() => null);
  if (!st?.isFile()) throw new Error('That file isn\'t in the shared folder.');
  return { handle: await fs.open(file, 'r'), size: st.size, name };
}
export async function startUpload(dir, name, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Bad file size.');
  const clean = safeName(name);
  await fs.mkdir(dir, { recursive: true });
  const part = path.join(dir, `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
  const handle = await fs.open(part, 'wx');
  let got = 0, queue = Promise.resolve(), over = false;
  const abort = () => { if (over) return; over = true; queue = queue.catch(() => {}).then(() => handle.close()).then(() => fs.unlink(part)).catch(() => {}); };
  async function finish() {
    over = true;
    await handle.close();
    const ext = path.extname(clean), base = clean.slice(0, clean.length - ext.length);
    for (let i = 0; i < 1000; i++) {
      const final = i ? `${base} (${i})${ext}` : clean;
      try { await fs.link(part, path.join(dir, final)); }
      catch (e) {
        if (e.code === 'EEXIST') continue;
        await fs.copyFile(part, path.join(dir, final), fs.constants.COPYFILE_EXCL); // no hard links on this disk
      }
      await fs.unlink(part);
      return final;
    }
    throw new Error('Too many files with that name.');
  }
  return {
    abort,
    /** Returns the saved name after the last chunk, else null. */
    write(data) {
      const r = queue.then(async () => {
        if (over) throw new Error('This upload was stopped.');
        got += data.length;
        if (got > size) throw new Error('The file is bigger than announced.');
        await handle.write(data);
        return got === size ? finish() : null;
      });
      queue = r.catch(() => {});
      return r;
    },
  };
}
