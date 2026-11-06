import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Firestore のルールが、ブラウザからの読み書きをすべて断ること。
// Admin SDK にルールは効かないので、ブラウザから直接届く道だけをここで閉じる。
// 書かれた内容はいつも確かめる。実際に断ることは、エミュレーターがあるときだけ確かめる
// （FIRESTORE_EMULATOR_HOST。手順は docs/spec/account.md の「手元で動かす」）。

const RULES = fileURLToPath(new URL("../../../../firestore.rules", import.meta.url));
const PROJECT = "demo-matsuri-ikoka";

describe("firestore.rules の内容", () => {
  it("許す決まりは、すべてに対して false の1つだけ", async () => {
    const text = await readFile(RULES, "utf8");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("//"));

    expect(lines.filter((line) => line.startsWith("allow"))).toEqual([
      "allow read, write: if false;",
    ]);
    expect(lines.filter((line) => line.startsWith("match"))).toEqual([
      "match /databases/{database}/documents {",
      "match /{document=**} {",
    ]);
  });
});

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

/** エミュレーターが受け付ける、署名のない ID トークン（ブラウザからログインした利用者のふりをする） */
function unsignedIdToken(uid: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: "none", kid: "fakekid", typ: "JWT" }),
    encode({
      iss: `https://securetoken.google.com/${PROJECT}`,
      aud: PROJECT,
      sub: uid,
      user_id: uid,
      auth_time: now,
      iat: now,
      exp: now + 3600,
      firebase: { identities: {}, sign_in_provider: "custom" },
    }),
    "",
  ].join(".");
}

describe.skipIf(emulator === undefined)("ブラウザからの読み書き（エミュレーター）", () => {
  const base = `http://${emulator}/v1/projects/${PROJECT}/databases/(default)/documents`;
  const asUser = { authorization: `Bearer ${unsignedIdToken("user-1")}` };
  const documents = [
    "itineraries/trip-1",
    "itineraries/trip-1/versions/000001",
    "shares/sh-1",
    "sessions/s-1",
    "users/user-1/trips/trip-1",
    "users/user-1",
  ];
  const fields = JSON.stringify({ fields: { ownerUid: { stringValue: "user-1" } } });

  describe.each([
    { name: "ログインなし", headers: {} as Record<string, string> },
    { name: "ログインした本人", headers: asUser as Record<string, string> },
  ])("$name", ({ headers }) => {
    it.each(documents)("%s を読めない", async (document) => {
      const res = await fetch(`${base}/${document}`, { headers });
      expect(res.status).toBe(403);
    });

    it.each(documents)("%s に書けない", async (document) => {
      const res = await fetch(`${base}/${document}`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: fields,
      });
      expect(res.status).toBe(403);
    });

    it.each(documents)("%s を消せない", async (document) => {
      const res = await fetch(`${base}/${document}`, { method: "DELETE", headers });
      expect(res.status).toBe(403);
    });

    it.each(["itineraries", "shares", "sessions", "users"])("%s を一覧できない", async (group) => {
      const res = await fetch(`${base}/${group}`, { headers });
      expect(res.status).toBe(403);
    });
  });
});
