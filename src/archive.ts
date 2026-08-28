import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * A ZIP writer, stored rather than deflated, in about eighty lines.
 *
 * The console could only ever hand back one PNG at a time, which is not how a
 * producer collects a campaign. Everything needed to fix that is a zip of the
 * output folder, and reaching for a dependency to build one would have added a
 * package, a licence and a supply-chain question to save this file.
 *
 * Stored (method 0) on purpose: the payload is PNGs and a JSON report, and PNG
 * is already deflate-compressed internally. Re-compressing it buys a few
 * percent for real CPU on every download. Storing also keeps this readable --
 * there is no compression state machine, just headers around bytes.
 *
 * Format is APPNOTE 6.3.2, the subset every unzip implementation has supported
 * for decades: a local header per file, then the central directory, then the
 * end-of-central-directory record.
 */

/** Standard CRC-32 (IEEE 802.3), which the ZIP central directory requires. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

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
    const data = await readFile(path.join(dir, name));
    // Always forward slashes in a zip entry, whatever the host separator is.
    const entryName = Buffer.from(path.posix.join(prefix, name.split(path.sep).join("/")), "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(entryName.length, 26);
    locals.push(local, entryName, data);

    const dirEntry = Buffer.alloc(46);
    dirEntry.writeUInt32LE(0x02014b50, 0); // central directory signature
    dirEntry.writeUInt16LE(20, 4); // version made by
    dirEntry.writeUInt16LE(20, 6); // version needed
    dirEntry.writeUInt16LE(0x0800, 8);
    dirEntry.writeUInt16LE(0, 10);
    dirEntry.writeUInt32LE(crc, 16);
    dirEntry.writeUInt32LE(data.length, 20);
    dirEntry.writeUInt32LE(data.length, 24);
    dirEntry.writeUInt16LE(entryName.length, 28);
    dirEntry.writeUInt32LE(offset, 42); // where the local header sits
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
