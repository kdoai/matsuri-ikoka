import { afterEach, describe, expect, it, vi } from "vitest";
import { type AccountUser, createAccountClient } from "./client";

// 本物の Firebase の部品を、手元の Auth のエミュレーターにつないで、ログインの流れを通す。
// CI にはエミュレーターがないので、FIREBASE_AUTH_EMULATOR_HOST があるときだけ動かす（docs/spec/account.md）。

const host = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
  .FIREBASE_AUTH_EMULATOR_HOST;
const PASSWORD = "long-enough-password";

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (String(input) === "/api/auth/config") {
      return Response.json({
        enabled: true,
        apiKey: "demo-api-key",
        authDomain: "demo-matsuri-ikoka.firebaseapp.com",
        projectId: "demo-matsuri-ikoka",
        emulatorUrl: `http://${host}`,
      });
    }
    return Response.json({ deleted: 0 });
  });
  const client = createAccountClient({ fetch });
  const users: (AccountUser | null)[] = [];
  client.onUser((user) => users.push(user));
  const email = `person-${crypto.randomUUID()}@example.com`;
  return { client, users, email, fetch };
}

describe.skipIf(host === undefined)("Auth のエミュレーターでのログイン", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("登録・ログアウト・ログイン・再設定・確かめ直しのうえでの削除を通す", async () => {
    const { client, users, email, fetch } = setup();

    await client.signUpWithPassword(email, PASSWORD);
    await vi.waitFor(() => expect(users.at(-1)?.usesPassword).toBe(true));
    expect(await client.idToken()).toEqual(expect.any(String));

    await client.signOut();
    await vi.waitFor(() => expect(users.at(-1)).toBeNull());
    expect(await client.idToken()).toBeNull();

    await expect(client.signInWithPassword(email, "wrong-password")).rejects.toMatchObject({
      failure: "credentials",
    });
    await client.signInWithPassword(email, PASSWORD);
    await vi.waitFor(() => expect(users.at(-1)).not.toBeNull());

    await expect(client.sendPasswordReset(email)).resolves.toBeUndefined();

    await expect(client.deleteEverything("wrong-password")).rejects.toMatchObject({
      failure: "credentials",
    });
    expect(fetch.mock.calls.map(([path]) => path)).not.toContain("/api/me/trips");

    await client.deleteEverything(PASSWORD);
    await vi.waitFor(() => expect(users.at(-1)).toBeNull());
    expect(fetch.mock.calls.map(([path]) => path)).toContain("/api/me/trips");

    // アカウントは消えたので、もう同じパスワードで入れない
    await expect(client.signInWithPassword(email, PASSWORD)).rejects.toMatchObject({
      failure: "credentials",
    });
  });

  it("同じメールアドレスでは二度登録できず、登録のないアドレスの再設定も同じように終わる", async () => {
    const { client, email } = setup();
    await client.signUpWithPassword(email, PASSWORD);
    await client.signOut();

    await expect(client.signUpWithPassword(email, PASSWORD)).rejects.toMatchObject({
      failure: "sign_up_refused",
    });
    await expect(client.sendPasswordReset(`nobody-${email}`)).resolves.toBeUndefined();
  });
});
