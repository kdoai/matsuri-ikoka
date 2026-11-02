import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fictionalFestival } from "@matsuri-ikoka/schema/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testFestival } from "../domain/testFestivals";
import { createFestivalStore, festivalDirs, loadFestivals } from "./festivalStore";

describe("createFestivalStore", () => {
  const store = createFestivalStore([
    testFestival({ id: "one-day", date: "2026-08-16" }),
    testFestival({ id: "three-days", date: "2026-08-14", endDate: "2026-08-16" }),
    testFestival({ id: "opted-out", date: "2026-08-16", optOut: true }),
    testFestival({
      id: "two-prefectures",
      date: "2026-09-01",
      edit: (f) => {
        f.municipalities = [
          { prefecture: "京都府", name: "架空川町" },
          { prefecture: "滋賀県", name: "架空橋町" },
        ];
      },
    }),
  ]);

  it("掲載停止の祭りは、索引にも参照にも出さない", () => {
    expect(store.size).toBe(3);
    expect(store.get("opted-out")).toBeUndefined();
    expect(store.onDates("2026-08-16", "2026-08-16").map((f) => f.id)).not.toContain("opted-out");
  });

  it("日付で引ける。複数日の開催は、どの日でも引ける", () => {
    expect(store.onDates("2026-08-15", "2026-08-15").map((f) => f.id)).toEqual(["three-days"]);
    expect(
      store
        .onDates("2026-08-16", "2026-08-16")
        .map((f) => f.id)
        .sort(),
    ).toEqual(["one-day", "three-days"]);
    expect(store.onDates("2026-08-17", "2026-08-31")).toEqual([]);
  });

  it("都道府県で引ける。都道府県をまたぐ祭りは両方で引ける", () => {
    expect(store.inPrefecture("京都府").map((f) => f.id)).toEqual(["two-prefectures"]);
    expect(store.inPrefecture("滋賀県").map((f) => f.id)).toContain("two-prefectures");
  });
});

describe("loadFestivals", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "festivals-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, value: unknown) =>
    writeFile(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));

  it("スキーマに合うファイルだけを読み、合わないものは理由を残して除く", async () => {
    await write("suzunari-toro.json", fictionalFestival());
    await write("broken.json", "{");
    await write("no-sources.json", { ...fictionalFestival(), id: "no-sources", sources: [] });
    await write("wrong-name.json", { ...fictionalFestival(), id: "other-id" });
    await write("opted.json", { ...fictionalFestival(), id: "opted", optOut: true });
    await write("README.md", "# memo");

    const result = await loadFestivals([dir]);

    expect(result.store.list().map((f) => f.id)).toEqual(["suzunari-toro"]);
    expect(result.loaded).toBe(2);
    expect(result.optedOut).toBe(1);
    expect(result.issues.map((i) => path.basename(i.file)).sort()).toEqual([
      "broken.json",
      "no-sources.json",
      "wrong-name.json",
    ]);
  });

  it("ないフォルダは空として扱う", async () => {
    const result = await loadFestivals([path.join(dir, "missing")]);

    expect(result.store.size).toBe(0);
    expect(result.issues).toEqual([]);
  });
});

describe("festivalDirs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "repo-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const samples = () => path.join(root, "data", "samples", "festivals");

  it("data/festivals が空なら、開発では架空の祭りを使う。本番では使わない", async () => {
    expect(await festivalDirs({ repoRoot: root, mode: "live", production: false })).toEqual([
      samples(),
    ]);
    expect(await festivalDirs({ repoRoot: root, mode: "live", production: true })).toEqual([
      path.join(root, "data", "festivals"),
    ]);
  });

  it("mock は架空の祭りを読み、環境変数で場所を変えられる", async () => {
    expect(await festivalDirs({ repoRoot: root, mode: "mock", production: false })).toEqual([
      samples(),
    ]);
    expect(
      await festivalDirs({
        repoRoot: root,
        mode: "live",
        production: true,
        configured: ["/a", "/b"].join(path.delimiter),
      }),
    ).toEqual(["/a", "/b"]);
  });
});
