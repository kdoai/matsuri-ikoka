import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasscodeHolder, PASSCODE_HEADER } from "../transport/server";
import { TransportError, toClientError } from "../transport/types";
import { createAccountClient } from "./client";

// Firebase の部品の代わり。ネットワークに出ない
const firebaseAuth = vi.hoisted(() => ({
  currentUser: null as { displayName: string | null; getIdToken(): Promise<string> } | null,
}));

vi.mock("firebase/app", () => ({ initializeApp: () => ({}) }));
vi.mock("firebase/auth", () => ({
  getAuth: () => firebaseAuth,
  onAuthStateChanged: (_auth: unknown, listener: (user: unknown) => void) => {
    listener(firebaseAuth.currentUser);
    return () => {};
  },
  signOut: async () => {},
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createAccountClient", () => {
  it("ログインを用意していなければ、ログインを出さず、旅の API も呼ばない", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ enabled: false }));
    const client = createAccountClient({ fetch });
    const users: unknown[] = [];

    expect(await client.enabled()).toBe(false);
    client.onUser((user) => users.push(user));
    await expect(client.listTrips()).rejects.toBeInstanceOf(TransportError);
    await vi.waitFor(() => expect(users).toEqual([null]));
    expect(fetch.mock.calls.every(([path]) => path === "/api/auth/config")).toBe(true);
  });

  it("設定は合言葉を付けて読み、断られたら次に読み直す", async () => {
    const passcode = createPasscodeHolder();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({ code: "unauthorized", message: "合言葉が違います。", retryable: false }, 401),
      )
      .mockResolvedValueOnce(json({ enabled: false }));
    const client = createAccountClient({ passcode, fetch });

    expect(await client.enabled()).toBe(false);
    passcode.set("matsuri");
    expect(await client.enabled()).toBe(false);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get(PASSCODE_HEADER)).toBe("matsuri");
  });

  it("形の違う設定は、ログインなしとして扱う", async () => {
    const client = createAccountClient({ fetch: async () => json({ enabled: true }) });
    expect(await client.enabled()).toBe(false);
  });

  it("ログインの部品を読み込んでいなければ、通信せずにログインなしとして扱う", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ enabled: false }));
    const client = createAccountClient({ fetch });

    expect(await client.idToken()).toBeNull();
    expect(await client.ownShioriPath("trip-1")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("ログインしているとき", () => {
  const CONFIG = { enabled: true, apiKey: "public-key", authDomain: "example.com", projectId: "p" };

  /** ログインの部品を読み込んだ通信の口を作る */
  async function signedIn(replies: (path: string) => Response) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = String(input);
      return path === "/api/auth/config" ? json(CONFIG) : replies(path);
    });
    const client = createAccountClient({ fetch });
    const users: unknown[] = [];
    client.onUser((user) => users.push(user));
    await vi.waitFor(() => expect(users.length).toBeGreaterThan(0));
    const calls = () =>
      fetch.mock.calls.filter(([path]) => path !== "/api/auth/config").map(([path]) => path);
    return { client, fetch, calls };
  }

  const share = (id: string) =>
    json({ shareId: id, path: `/shiori/${id}`, expiresAt: "2026-09-01T00:00:00.000Z" }, 201);

  beforeEach(() => {
    firebaseAuth.currentUser = { displayName: "利用者", getIdToken: async () => "id-token" };
  });

  afterEach(() => {
    firebaseAuth.currentUser = null;
  });

  it("ID トークンを返す。ログアウトしたら null", async () => {
    const { client } = await signedIn(() => json({}));

    expect(await client.idToken()).toBe("id-token");
    firebaseAuth.currentUser = null;
    expect(await client.idToken()).toBeNull();
  });

  it("ログイン中にトークンを取れなければ、再試行できるエラーにする", async () => {
    const { client } = await signedIn(() => json({}));
    firebaseAuth.currentUser = {
      displayName: null,
      getIdToken: async () => {
        throw new Error("更新に失敗");
      },
    };

    await expect(client.idToken()).rejects.toMatchObject({ code: "connection_lost" });
    expect(toClientError(await client.idToken().catch((error) => error)).retryable).toBe(true);
  });

  it("自分の旅程のしおりは、サーバーに頼んで受け取った共有で開く", async () => {
    let made = 0;
    const { client, calls } = await signedIn(() => {
      made += 1;
      return share(`sh-${made}`);
    });

    expect(await client.ownShioriPath("trip-1")).toBe("/shiori/sh-1");
    expect(await client.ownShioriPath("trip-1")).toBe("/shiori/sh-2");
    // 使い回すかどうかはサーバーが決めるので、控えを持たずに毎回頼む
    expect(calls()).toEqual(["/api/trips/trip-1/share", "/api/trips/trip-1/share"]);
  });

  it("自分の旅程でなければ、旅程の ID のまま開く", async () => {
    const { client } = await signedIn(() =>
      json({ code: "bad_request", message: "旅が見つかりません。", retryable: false }, 404),
    );

    expect(await client.ownShioriPath("trip-1")).toBeNull();
  });

  it("共有を作れなければ、エラーにする（旅程の ID で開くと「見つかりません」になる）", async () => {
    const { client } = await signedIn(() =>
      json({ code: "internal", message: "サーバーでエラーが起きました。", retryable: true }, 500),
    );

    await expect(client.ownShioriPath("trip-1")).rejects.toBeInstanceOf(TransportError);
  });

  it("ログインしていなければ、共有を頼まない", async () => {
    const { client, calls } = await signedIn(() => share("sh-1"));
    firebaseAuth.currentUser = null;

    expect(await client.ownShioriPath("trip-1")).toBeNull();
    expect(calls()).toEqual([]);
  });
});
