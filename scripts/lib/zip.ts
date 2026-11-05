import { inflateRawSync } from "node:zlib";

// zip の中のファイルを1つ取り出す（展開のための道具を入れずに済むよう、中央ディレクトリを読む）。
// 対応するのは、無圧縮（0）と deflate（8）だけ。

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** zip の中のファイルの一覧 */
export function zipEntries(zip: Buffer): ZipEntry[] {
  // 終わりの記録は、最後のコメント（最大 65535 バイト）の前にある
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i -= 1) {
    if (zip.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("zip の終わりの記録が見つかりません");
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error("zip の中央ディレクトリが読めません");
    }
    const flags = zip.readUInt16LE(offset + 8);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const rawName = zip.subarray(offset + 46, offset + 46 + nameLength);
    // 名前は UTF-8 の印（11ビット目）があれば UTF-8、なければ ASCII の範囲だけを当てにする
    const name = rawName.toString(flags & 0x800 ? "utf8" : "latin1");
    entries.push({
      name,
      method: zip.readUInt16LE(offset + 10),
      compressedSize: zip.readUInt32LE(offset + 20),
      localHeaderOffset: zip.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 1つのファイルの中身 */
export function readZipEntry(zip: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localHeaderOffset;
  if (zip.readUInt32LE(at) !== LOCAL_FILE_HEADER) throw new Error(`${entry.name} が読めません`);
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`${entry.name} の圧縮の方法（${entry.method}）には対応していません`);
}
