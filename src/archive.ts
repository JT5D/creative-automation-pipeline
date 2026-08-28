import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";

/**
 * The campaign as one download.
 *
 * A producer collects a campaign, not one PNG at a time. Zip is the only
 * container a reviewer on any desktop platform opens by double-clicking, and
 * it is worth fifty lines rather than a dependency plus a licence plus a
 * supply-chain question.
 *
 * Stored (method 0), not deflated: the payload is PNGs, already
 * deflate-compressed internally. Re-compressing costs CPU on every download
 * for a few percent, and storing means no compression state machine here.
 *
 * Format is APPNOTE 6.3.2, the subset every unzip has supported for decades.
 * The checksum is `node:zlib`'s `crc32`, available since Node 20.15.
 */

/** Every file under `dir`, relative to it, depth first and sorted. */
async function walk(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files;
}

/** UTF-8 names, stored, no encryption. Identical in both headers. */
const FLAGS = 0x0800;
const STORED = 0;
const VERSION = 20;

/**
 * MS-DOS date and time, which is what a zip entry stores.
 *
 * Skipping these is legal and every unzip accepts it, so the archive passed
 * `unzip -t` without them. It also meant every file in the campaign listed as
 * `00-00-1980`, which is what a producer sees the moment they open the folder.
 * Two seconds of resolution and a 1980 epoch are the format's, not ours.
 */
function dosStamp(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getFullYear());
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/**
 * Zips a directory into one buffer.
 *
 * Held in memory deliberately: a campaign is a few dozen PNGs, and streaming
 * would mean tracking offsets across chunks for a payload that fits comfortably
 * in a browser download. If campaigns ever got large this is the seam to stream.
 */
export async function zipDirectory(dir: string, prefix = ""): Promise<Buffer> {
  await stat(dir); // throws if the campaign does not exist, which the caller maps to 404
  const names = await walk(dir);

  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const name of names) {
    const file = path.join(dir, name);
    const data = await readFile(file);
    const stamp = dosStamp((await stat(file)).mtime);
    // Always forward slashes in a zip entry, whatever the host separator is.
    const entryName = Buffer.from(path.posix.join(prefix, name.split(path.sep).join("/")), "utf8");
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(STORED, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18); // compressed size, same as stored
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(entryName.length, 26);
    locals.push(local, entryName, data);

    const dirEntry = Buffer.alloc(46);
    dirEntry.writeUInt32LE(0x02014b50, 0); // central directory signature
    dirEntry.writeUInt16LE(VERSION, 4); // version made by
    dirEntry.writeUInt16LE(VERSION, 6); // version needed
    dirEntry.writeUInt16LE(FLAGS, 8);
    dirEntry.writeUInt16LE(STORED, 10);
    dirEntry.writeUInt16LE(stamp.time, 12);
    dirEntry.writeUInt16LE(stamp.date, 14);
    dirEntry.writeUInt32LE(checksum, 16);
    dirEntry.writeUInt32LE(data.length, 20);
    dirEntry.writeUInt32LE(data.length, 24);
    dirEntry.writeUInt16LE(entryName.length, 28);
    dirEntry.writeUInt32LE(offset, 42); // where this file's local header sits
    central.push(dirEntry, entryName);

    offset += local.length + entryName.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}
