import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZipEntry, zipEntries } from "./zip";

/** テスト用の小さな zip を作る（ファイルごとに無圧縮か deflate） */
function makeZip(files: { name: string; body: string; deflate: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.body, "utf8");
    const data = file.deflate ? deflateRawSync(raw) : raw;
    const method = file.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("zip", () => {
  const zip = makeZip([
    { name: "data/README.txt", body: "架空の説明", deflate: false },
    { name: "data/UTF-8/stations.geojson", body: '{"features":[]}'.repeat(10), deflate: true },
  ]);

  it("中のファイルの一覧を読む", () => {
    expect(zipEntries(zip).map((entry) => entry.name)).toEqual([
      "data/README.txt",
      "data/UTF-8/stations.geojson",
    ]);
  });

  it("無圧縮と deflate のファイルを取り出す", () => {
    const [readme, stations] = zipEntries(zip);
    if (readme === undefined || stations === undefined) throw new Error("一覧が空です");
    expect(readZipEntry(zip, readme).toString("utf8")).toBe("架空の説明");
    expect(readZipEntry(zip, stations).toString("utf8")).toBe('{"features":[]}'.repeat(10));
  });

  it("zip でないものは読めないと伝える", () => {
    expect(() => zipEntries(Buffer.from("zip ではない架空のファイルの中身です"))).toThrow();
  });
});
