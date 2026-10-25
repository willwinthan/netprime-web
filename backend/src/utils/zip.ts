/**
 * Minimal ZIP reader for SCORM packages: central directory parsing, stored and deflate entries
 * (DecompressionStream "deflate-raw"), CRC-32 check and hard limits. No ZIP64, encryption or
 * multi-disk archives. Reads through a RangeReader so the archive can stay in R2.
 */

export interface RangeReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

export interface ZipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number }

export class ZipError extends Error {}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const decoder = new TextDecoder("utf-8");

/** Reads the end-of-central-directory record and the central directory entries. */
export async function readZipEntries(reader: RangeReader, limits: ZipLimits): Promise<ZipEntry[]> {
  if (reader.size < 22) throw new ZipError("ไฟล์ ZIP ไม่ถูกต้อง");
  const tailLength = Math.min(reader.size, 22 + 65535);
  const tail = await reader.read(reader.size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("ไฟล์ ZIP ไม่ถูกต้อง (ไม่พบสารบัญไฟล์)");
  if (u16(tail, eocd + 4) !== 0 || u16(tail, eocd + 6) !== 0) throw new ZipError("ไม่รองรับไฟล์ ZIP แบบแบ่งหลายส่วน");
  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("ไม่รองรับไฟล์ ZIP64 กรุณาบีบอัดใหม่ให้มีขนาดเล็กลง");
  if (count > limits.maxEntries) throw new ZipError(`แพ็กเกจมีไฟล์มากเกิน ${limits.maxEntries} ไฟล์`);
  if (cdOffset + cdSize > reader.size || cdSize > 16 * 1024 * 1024) throw new ZipError("ไฟล์ ZIP ไม่ถูกต้อง (สารบัญไฟล์เสียหาย)");

  const cd = await reader.read(cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let total = 0;
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) throw new ZipError("ไฟล์ ZIP ไม่ถูกต้อง (สารบัญไฟล์เสียหาย)");
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const crc32 = u32(cd, p + 16);
    const compressedSize = u32(cd, p + 20);
    const uncompressedSize = u32(cd, p + 24);
    const nameLength = u16(cd, p + 28);
    const extraLength = u16(cd, p + 30);
    const commentLength = u16(cd, p + 32);
    const localHeaderOffset = u32(cd, p + 42);
    if (p + 46 + nameLength > cd.length) throw new ZipError("ไฟล์ ZIP ไม่ถูกต้อง (สารบัญไฟล์เสียหาย)");
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;

    const isDirectory = name.endsWith("/") || name.endsWith("\\");
    if (flags & 0x1) throw new ZipError("ไม่รองรับไฟล์ ZIP ที่ตั้งรหัสผ่าน");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff)
      throw new ZipError("ไม่รองรับไฟล์ ZIP64 กรุณาบีบอัดใหม่ให้มีขนาดเล็กลง");
    if (!isDirectory) {
      if (method !== 0 && method !== 8) throw new ZipError(`ไม่รองรับวิธีบีบอัดของไฟล์ ${name}`);
      if (uncompressedSize > limits.maxEntryBytes) throw new ZipError(`ไฟล์ ${name} ใหญ่เกินกำหนด (ไม่เกิน ${Math.floor(limits.maxEntryBytes / 1048576)} MB ต่อไฟล์)`);
      total += uncompressedSize;
      if (total > limits.maxTotalBytes) throw new ZipError("ขนาดรวมของไฟล์หลังแตก ZIP ใหญ่เกินกำหนด");
      if (localHeaderOffset + 30 + compressedSize > reader.size) throw new ZipError(`ไฟล์ ${name} ในแพ็กเกจเสียหาย`);
    }
    entries.push({ name, method, flags, crc32, compressedSize, uncompressedSize, localHeaderOffset, isDirectory });
  }
  return entries;
}

/**
 * Normalizes an entry name to a safe relative path ("a/b.html"), or null for anything that could
 * escape the package folder (zip-slip): absolute paths, drive letters, "..", control characters.
 */
export function safeEntryPath(name: string): string | null {
  if (!name || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  const unified = name.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
  const parts: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    parts.push(segment);
  }
  return parts.length ? parts.join("/") : null;
}

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Inflates raw deflate data straight into a buffer of the size the central directory declared, aborting as
 * soon as the output passes it (zip bombs). Chunks are copied into the preallocated buffer as they arrive, so
 * peak memory is about compressed + uncompressed size (no chunk list plus a second concatenated copy).
 */
async function inflateRaw(data: Uint8Array, expectedBytes: number): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // Not awaited before reading: the readable side must drain or the write would wait on backpressure.
  const writing = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => undefined);
  const reader = stream.readable.getReader();
  const out = new Uint8Array(expectedBytes);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > expectedBytes) throw new ZipError("ข้อมูลในแพ็กเกจใหญ่กว่าที่ระบุไว้");
      out.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error instanceof ZipError ? error : new ZipError("ข้อมูลในแพ็กเกจเสียหาย (แตกไฟล์ไม่สำเร็จ)");
  } finally {
    await writing;
  }
  return size === expectedBytes ? out : out.subarray(0, size);
}

/** Reads and decompresses one entry, verifying its size and CRC-32. */
export async function readZipEntry(reader: RangeReader, entry: ZipEntry): Promise<Uint8Array> {
  const header = await reader.read(entry.localHeaderOffset, 30);
  if (u32(header, 0) !== 0x04034b50) throw new ZipError(`ไฟล์ ${entry.name} ในแพ็กเกจเสียหาย`);
  const dataOffset = entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28);
  if (dataOffset + entry.compressedSize > reader.size) throw new ZipError(`ไฟล์ ${entry.name} ในแพ็กเกจเสียหาย`);
  // Callers cap entry sizes (see ZipLimits) so one entry never needs more than ~2× its size in memory.
  const maxCompressed = entry.method === 0 ? entry.uncompressedSize : entry.uncompressedSize + (entry.uncompressedSize >> 8) + 1024;
  if (entry.compressedSize > maxCompressed) throw new ZipError(`ไฟล์ ${entry.name} ในแพ็กเกจเสียหาย`);
  const raw = entry.compressedSize ? await reader.read(dataOffset, entry.compressedSize) : new Uint8Array(0);
  const data = entry.method === 0 ? raw : await inflateRaw(raw, entry.uncompressedSize);
  if (data.byteLength !== entry.uncompressedSize || crc32(data) !== entry.crc32)
    throw new ZipError(`ไฟล์ ${entry.name} ในแพ็กเกจเสียหาย (ตรวจสอบข้อมูลไม่ผ่าน)`);
  return data;
}

/**
 * RangeReader over an R2 object that fetches windows of `windowBytes` so consecutive small
 * entries share one R2 read.
 */
export function r2RangeReader(bucket: R2Bucket, key: string, size: number, windowBytes = 8 * 1024 * 1024): RangeReader {
  let windowStart = 0;
  let windowData: Uint8Array | null = null;
  return {
    size,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > size) throw new ZipError("ไฟล์ ZIP ไม่ถูกต้อง");
      if (length === 0) return new Uint8Array(0);
      if (windowData && offset >= windowStart && offset + length <= windowStart + windowData.length)
        return windowData.subarray(offset - windowStart, offset - windowStart + length);
      const fetchLength = Math.min(size - offset, Math.max(length, windowBytes));
      const object = await bucket.get(key, { range: { offset, length: fetchLength } });
      if (!object) throw new ZipError("ไม่พบไฟล์แพ็กเกจที่อัปโหลด");
      const data = new Uint8Array(await object.arrayBuffer());
      if (data.length < length) throw new ZipError("ไฟล์ ZIP ไม่ถูกต้อง");
      // Very large reads (one big entry) are not kept as the window.
      if (fetchLength <= windowBytes) { windowStart = offset; windowData = data; }
      return data.subarray(0, length);
    }
  };
}
