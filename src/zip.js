/**
 * Minimal ZIP read/write, enough to open an .xlsx, swap out a couple of its
 * XML parts, and write it back with everything else untouched.
 *
 * The point of reading entries as *raw* (still-compressed) bytes is fidelity:
 * parts we don't modify are copied straight through with their original
 * compression method, CRC and sizes, so the output differs from the input only
 * in the parts we deliberately rewrote. Nothing else in the workbook — styles,
 * sheet protection, conditional formatting, data validations, printer
 * settings, the other worksheets — can be perturbed by a round trip.
 *
 * Uses the platform's DecompressionStream/CompressionStream, so there is no
 * inflate implementation to carry.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * @typedef {object} ZipEntry
 * @property {string} path
 * @property {Uint8Array} raw bytes as stored (deflated when method is 8)
 * @property {number} method 0 = stored, 8 = deflated
 * @property {number} crc
 * @property {number} size uncompressed length
 * @property {number} flags
 * @property {number} time
 * @property {number} date
 */

/**
 * Read a ZIP archive into its entries, preserving stored bytes verbatim.
 * @param {Uint8Array} bytes
 * @returns {ZipEntry[]}
 */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record lives in the last 64KB, after an
  // optional trailing comment, so scan backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65557; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record).');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL_SIG) {
      throw new Error('Corrupt ZIP central directory.');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    // Sizes come from the central directory; the local header's own name/extra
    // lengths tell us where its payload starts.
    if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`Corrupt ZIP local header for ${path}.`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    entries.push({
      path,
      raw: bytes.subarray(dataStart, dataStart + compSize),
      method,
      crc,
      size,
      flags,
      time,
      date,
    });

    at += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** Inflate an entry's bytes to text. */
export async function entryText(entry) {
  if (entry.method === 0) return new TextDecoder().decode(entry.raw);
  if (entry.method !== 8) {
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.path}.`);
  }
  const stream = new Blob([entry.raw])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Build a replacement entry holding `text`, deflated. */
export async function textEntry(path, text) {
  const source = new TextEncoder().encode(text);
  const stream = new Blob([source])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  const deflated = new Uint8Array(await new Response(stream).arrayBuffer());
  return {
    path,
    raw: deflated,
    method: 8,
    crc: crc32(source),
    size: source.length,
    flags: 0,
    time: 0,
    date: 0x21,
  };
}

/**
 * Write entries back out as a ZIP, in the order given.
 * @param {ZipEntry[]} entries
 * @returns {Uint8Array}
 */
export function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.path);
    const compSize = entry.raw.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true);
    // Drop the data-descriptor flag: sizes are written in the header here.
    lv.setUint16(6, entry.flags & ~0x08, true);
    lv.setUint16(8, entry.method, true);
    lv.setUint16(10, entry.time, true);
    lv.setUint16(12, entry.date, true);
    lv.setUint32(14, entry.crc, true);
    lv.setUint32(18, compSize, true);
    lv.setUint32(22, entry.size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, entry.raw);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, CENTRAL_SIG, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, entry.flags & ~0x08, true);
    dv.setUint16(10, entry.method, true);
    dv.setUint16(12, entry.time, true);
    dv.setUint16(14, entry.date, true);
    dv.setUint32(16, entry.crc, true);
    dv.setUint32(20, compSize, true);
    dv.setUint32(24, entry.size, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + compSize;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of all) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}
