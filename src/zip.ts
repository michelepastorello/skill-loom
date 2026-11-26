/** A minimal ZIP writer.
 *
 *  skill-loom ships with no runtime dependencies and the dashboard is served
 *  from the same process that reads the vault, so handing a skill folder to a
 *  person is a matter of forty lines of the format rather than a package: local
 *  header, deflate, central directory, end record. Node's zlib already does the
 *  compression; what is missing is the container around it.
 *
 *  Deliberately not implemented: zip64 (a skill folder is kilobytes, and the
 *  writer refuses rather than silently truncating), encryption, and data
 *  descriptors (sizes are known before writing because everything is in
 *  memory). */
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  path: string;
  data: Buffer;
  mtime?: Date;
}

// One table, built once: the polynomial is reversed because ZIP walks the
// bytes low bit first.
let CRC_TABLE: Int32Array | null = null;
function crcTable(): Int32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(buf: Buffer): number {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS date/time: two 16-bit fields, seconds at 2s resolution, years from
 *  1980. Anything older than 1980 clamps rather than wrapping into a date the
 *  format cannot express. */
function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const ZIP64_LIMIT = 0xffffffff;

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.path, "utf8");
    const raw = e.data;
    // Store when deflating does not pay for itself: already-compressed files
    // (a png in a skill's references) otherwise grow by a few bytes.
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosTime(e.mtime ?? new Date(0));
    const crc = crc32(raw);
    if (raw.length > ZIP64_LIMIT || body.length > ZIP64_LIMIT)
      throw new Error(`${e.path} is too large for a non-zip64 archive`);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x800, 6); // flags: names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory header
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    // External attrs: unix mode 0644 in the high half. `>>> 0` because the
    // shift lands past 2^31 and JS hands back a signed (negative) number,
    // which writeUInt32LE refuses.
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment
  return Buffer.concat([...locals, cdBuf, end]);
}
