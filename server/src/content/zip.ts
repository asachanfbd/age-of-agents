import { crc32 } from 'node:zlib';

export interface ZipEntry { name: string; bytes: Buffer }

/** A plain file name for inside the zip: no folders, no control characters. */
export function zipEntryName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, '').replace(/^\.+/, '').trim();
  return base || 'file';
}

/** Makes names unique by numbering repeats (`a.png`, `a (2).png`). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = zipEntryName(raw);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  });
}

const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const UTF8_FLAG = 0x0800;

/** A zip with every entry stored uncompressed (images are already compressed). */
export function buildZip(entries: ZipEntry[]): Buffer {
  const names = uniqueNames(entries.map((e) => e.name));
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  entries.forEach((entry, i) => {
    const name = Buffer.from(names[i]!, 'utf8');
    const crc = crc32(entry.bytes), size = entry.bytes.length;
    const header = Buffer.concat([u32(0x04034b50), u16(20), u16(UTF8_FLAG), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(name.length), u16(0), name]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(UTF8_FLAG), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    parts.push(header, entry.bytes);
    offset += header.length + size;
  });
  const directory = Buffer.concat(central);
  return Buffer.concat([...parts, directory, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset), u16(0)]);
}
