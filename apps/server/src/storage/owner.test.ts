import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryTripStorage } from "./memory";
import { isDocumentId, ownerIdOf, ownerTripPath } from "./owner";

const srcDir = fileURLToPath(new URL("../", import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    }),
  );
  return nested.flat();
}

describe("持ち主を決めずに利用者のデータを読み書きする口はない", () => {
  it("絞らない呼び出しは、型の検査（pnpm typecheck）で落ちる", () => {
    const storage = new MemoryTripStorage();
    // 実際には呼ばない。下の行に型の誤りがなければ、@ts-expect-error で型の検査が落ちる
    const unscoped = () => {
      // @ts-expect-error 持ち主の ID は、ただの文字列からは作れない
      storage.forOwner("user-1");
      // @ts-expect-error 持ち主を決めずに旅の一覧を読む口はない
      storage.listTrips("user-1");
      // @ts-expect-error 持ち主を決めずに旅を読む口はない
      storage.getTrip("user-1", "trip-1");
      // @ts-expect-error 持ち主を決めずに旅を残す口はない
      storage.claimTrip("user-1", "trip-1");
      // @ts-expect-error 持ち主を決めずに旅を消す口はない
      storage.deleteTrip("user-1", "trip-1");
      // @ts-expect-error 持ち主を決めずに旅を共有する口はない
      storage.createShare("user-1", "trip-1");
      // @ts-expect-error 旅程の ID でも共有の ID でも読める口はなくした
      storage.getShared("trip-1");
      // @ts-expect-error 旅程を保存するときは、相談の持ち主を必ず渡す
      storage.saveItinerary({});
    };
    expect(unscoped).toBeTypeOf("function");
  });

  it("持ち主の ID は、ID トークンを確かめた直後と、保存した持ち主を戻すときにしか作らない", async () => {
    const files = await sourceFiles(srcDir);
    const minted: string[] = [];
    for (const file of files) {
      const relative = path.relative(srcDir, file).split(path.sep).join("/");
      // テストの決まりを書いた contract.ts はテストと同じ扱いにする
      if (relative.endsWith(".test.ts") || relative === "storage/contract.ts") continue;
      const text = await readFile(file, "utf8");
      if (/\bownerIdOf\(/.test(text)) minted.push(relative);
    }

    expect(minted.sort()).toEqual([
      "account/idToken.ts",
      "session/persistence.ts",
      "storage/owner.ts",
    ]);
  });

  it("経路の中では、相談の保管庫と保存の口を直接使わない", async () => {
    const files = await sourceFiles(path.join(srcDir, "routes"));
    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const text = await readFile(file, "utf8");
      expect(text, file).not.toMatch(/\bsessions\.(get|create|restore)\(/);
      expect(text, file).not.toMatch(/persistence\??\.load\(/);
      expect(text, file).not.toMatch(/import .*\bTripStorage\b.*storage\/types/);
    }
  });
});

describe("持ち主を含む置き場のパス", () => {
  const owner = ownerIdOf("user-1");

  it("持ち主から始まるパスを作る", () => {
    expect(ownerTripPath(owner, "trip-1")).toBe("users/user-1/trips/trip-1");
    expect(ownerTripPath(owner, "trip-1", "notices", "n-1")).toBe(
      "users/user-1/trips/trip-1/notices/n-1",
    );
  });

  it.each(["", ".", "..", "a/b", "__reserved__", "x".repeat(129)])(
    "文書の ID の形でない「%s」では作らない",
    (id) => {
      expect(isDocumentId(id)).toBe(false);
      expect(() => ownerTripPath(owner, id)).toThrow();
      expect(() => ownerTripPath(owner, "trip-1", id)).toThrow();
    },
  );
});
