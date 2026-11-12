// A folder as a .zip, streamed: each file deflated (or stored, when that's smaller), no dependencies.
// Plain ZIP (not ZIP64): up to 65,535 files and under 4 GB, which is checked before anything is sent.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Writable } from 'node:stream';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  const native = (zlib as { crc32?: (b: Buffer) => number }).crc32;
  if (native) return native(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) c = (TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const ZIP_LIMITS = { files: 65_535, bytes: 2 * 1024 * 1024 * 1024 };

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/** Write a zip of the given files (absolute path → name inside the zip) to out. */
export async function writeZip(out: Writable, files: { abs: string; name: string }[]): Promise<void> {
  const central: Buffer[] = [];
  let offset = 0;
  const write = (b: Buffer) =>
    new Promise<void>((resolve, reject) => {
      offset += b.length;
      if (out.write(b)) resolve();
      else {
        out.once('drain', resolve);
        out.once('error', reject);
      }
    });
  for (const f of files) {
    let data: Buffer, st: fs.Stats;
    try {
      st = await fs.promises.stat(f.abs);
      data = await fs.promises.readFile(f.abs);
    } catch {
      continue; // gone since it was listed
    }
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const name = Buffer.from(f.name, 'utf8');
    const [time, date] = dosTime(st.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const at = offset;
    await write(Buffer.concat([local, name]));
    await write(body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(store ? 0 : 8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(at, 42);
    central.push(Buffer.concat([cen, name]));
  }
  const start = offset;
  const dir = Buffer.concat(central);
  await write(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(start, 16);
  await write(end);
}

/** A zip-safe name for a root-relative path inside a folder being zipped. */
export const entryName = (folderName: string, rel: string) => path.posix.join(folderName, rel);
