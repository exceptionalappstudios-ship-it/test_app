import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';

// Profile photos arrive already resized and compressed by the browser
// (a small square JPEG, usually 20–50 KB). The server only checks and stores them.
export const MAX_PHOTO_BYTES = 400 * 1024;
export const PHOTO_NAME_RE = /^[a-f0-9]{32}\.jpg$/;

export function createPhotoStore(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const memory = new Map(); // used when no folder is given (tests)

  return {
    save(buffer) {
      if (!Buffer.isBuffer(buffer) || buffer.length < 1000) throw new HttpError(400, 'Please choose a photo');
      if (buffer.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'This photo is too large. Please try another one.');
      if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) throw new HttpError(400, 'Please upload a JPEG photo');
      const name = `${crypto.randomBytes(16).toString('hex')}.jpg`;
      if (dir) fs.writeFileSync(path.join(dir, name), buffer);
      else memory.set(name, buffer);
      return name;
    },
    remove(name) {
      if (!PHOTO_NAME_RE.test(name ?? '')) return;
      if (!dir) memory.delete(name);
      else fs.rmSync(path.join(dir, name), { force: true });
    },
    read(name) {
      if (!PHOTO_NAME_RE.test(name)) return null;
      if (!dir) return memory.get(name) ?? null;
      try { return fs.readFileSync(path.join(dir, name)); } catch { return null; }
    },
  };
}
