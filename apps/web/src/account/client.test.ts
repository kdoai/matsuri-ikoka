import { TRIAL_ACCOUNT_UID } from "@matsuri-ikoka/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasscodeHolder, PASSCODE_HEADER } from "../transport/server";
import { TransportError, toClientError } from "../transport/types";
import { loginFailureText } from "../ui/LoginForm";
import {
  type AccountClient,
  type AccountUser,
  createAccountClient,
  LoginError,
  watchUserLeaving,
} from "./client";

// Firebase の部品の代わり。ネットワークに出ない
interface FakeUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  providerData: { providerId: string }[];
  getIdToken(): Promise<string>;
}

const firebaseAuth = vi.hoisted(() => ({
  currentUser: null as FakeUser | null,
  listeners: [] as ((user: unknown) => void)[],
  /** 呼ばれた順の記録（確かめ直しと通信の順を見る） */
  steps: [] as string[],
  /** 次の呼び出しで投げるエラーのコード */
  failWith: {} as Record<string, string>,
}));

/** 呼ばれたことを記録し、頼まれていればエラーを投げる */
const step = vi.hoisted(() => (name: string) => {
  firebaseAuth.steps.push(name);
  const code = firebaseAuth.failWith[name];
  if (code !== undefined) throw Object.assign(new Error("failed"), { code });
});

const passwordUser = vi.hoisted(
  () => (uid: string) =>
    ({
      uid,
      email: "person@example.com",
      displayName: null,
      providerData: [{ providerId: "password" }],
      getIdToken: async () => "id-token",
    }) satisfies FakeUser,
);

vi.mock("firebase/app", () => ({ initializeApp: () => ({}) }));
vi.mock("firebase/auth", () => {
  const setUser = (user: FakeUser | null) => {
    firebaseAuth.currentUser = user;
    for (const listener of firebaseAuth.listeners) listener(user);
  };
  return {
    getAuth: () => firebaseAuth,
    onAuthStateChanged: (_auth: unknown, listener: (user: unknown) => void) => {
      firebaseAuth.listeners.push(listener);
      listener(firebaseAuth.currentUser);
      return () => {};
    },
    GoogleAuthProvider: class {},
    EmailAuthProvider: {
      credential: (email: string, password: string) => ({ email, password }),
    },
    signInWithPopup: async () => {
      step("signInWithPopup");
      setUser({
        ...passwordUser("google-user"),
        providerData: [{ providerId: "google.com" }],
        displayName: "利用者",
      });
    },
    signInWithEmailAndPassword: async () => {
      step("signInWithEmailAndPassword");
      setUser(passwordUser("password-user"));
    },
    createUserWithEmailAndPassword: async () => {
      step("createUserWithEmailAndPassword");
      setUser(passwordUser("new-user"));
    },
    sendPasswordResetEmail: async () => step("sendPasswordResetEmail"),
    signOut: async () => {
      step("signOut");
      setUser(null);
    },
    reauthenticateWithCredential: async () => step("reauthenticateWithCredential"),
    reauthenticateWithPopup: async () => step("reauthenticateWithPopup"),
    deleteUser: async () => {
      step("deleteUser");
      setUser(null);
    },
  };
});

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
    firebaseAuth.currentUser = { ...passwordUser("user-1"), displayName: "利用者" };
  });

  afterEach(() => {
    firebaseAuth.currentUser = null;
    firebaseAuth.listeners.length = 0;
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
      ...passwordUser("user-1"),
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

describe("ログインの方法", () => {
  const CONFIG = { enabled: true, apiKey: "public-key", authDomain: "example.com", projectId: "p" };

  function setup(replies: (path: string) => Response = () => json({ deleted: 0 })) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = String(input);
      if (path === "/api/auth/config") return json(CONFIG);
      firebaseAuth.steps.push(path);
      return replies(path);
    });
    const client = createAccountClient({ fetch });
    const users: (AccountUser | null)[] = [];
    client.onUser((user) => users.push(user));
    return {
      client,
      users,
      ready: () => vi.waitFor(() => expect(users.length).toBeGreaterThan(0)),
    };
  }

  beforeEach(() => {
    firebaseAuth.steps.length = 0;
    firebaseAuth.failWith = {};
  });

  afterEach(() => {
    firebaseAuth.currentUser = null;
    firebaseAuth.listeners.length = 0;
  });

  it.each([
    [
      "Google",
      (client: AccountClient) => client.signInWithGoogle(),
      { id: "google-user", name: "利用者", usesPassword: false, trial: false },
    ],
    [
      "パスワードでのログイン",
      (client: AccountClient) => client.signInWithPassword("person@example.com", "long-password"),
      { id: "password-user", name: null, usesPassword: true, trial: false },
    ],
    [
      "パスワードでの登録",
      (client: AccountClient) => client.signUpWithPassword("person@example.com", "long-password"),
      { id: "new-user", name: null, usesPassword: true, trial: false },
    ],
  ])("%s のあとログインの状態になり、ログアウトで戻る", async (_name, signIn, expected) => {
    const { client, users, ready } = setup();
    await ready();

    await signIn(client);
    expect(users.at(-1)).toEqual(expected);
    expect(await client.idToken()).toBe("id-token");

    await client.signOut();
    expect(users.at(-1)).toBeNull();
    expect(await client.idToken()).toBeNull();
  });

  it("登録がないときと、パスワードが違うときは、同じ失敗にする", async () => {
    const { client } = setup();
    const failureOf = async (code: string) => {
      firebaseAuth.failWith = { signInWithEmailAndPassword: code };
      const error = await client.signInWithPassword("a@example.com", "x").catch((e) => e);
      return (error as LoginError).failure;
    };

    expect(await failureOf("auth/user-not-found")).toBe("credentials");
    expect(await failureOf("auth/wrong-password")).toBe("credentials");
    expect(await failureOf("auth/invalid-credential")).toBe("credentials");
  });

  it("登録できないときは、登録があるとは言わない失敗にする", async () => {
    const { client } = setup();
    firebaseAuth.failWith = { createUserWithEmailAndPassword: "auth/email-already-in-use" };

    await expect(client.signUpWithPassword("a@example.com", "long-password")).rejects.toMatchObject(
      { failure: "sign_up_refused" },
    );
    expect(loginFailureText("ja", new LoginError("sign_up_refused"))).not.toContain("すでに");
  });

  it("再設定は、登録がなくても同じように終わる", async () => {
    const { client } = setup();
    await expect(client.sendPasswordReset("a@example.com")).resolves.toBeUndefined();

    firebaseAuth.failWith = { sendPasswordResetEmail: "auth/user-not-found" };
    await expect(client.sendPasswordReset("nobody@example.com")).resolves.toBeUndefined();

    firebaseAuth.failWith = { sendPasswordResetEmail: "auth/too-many-requests" };
    await expect(client.sendPasswordReset("a@example.com")).rejects.toMatchObject({
      failure: "too_many",
    });
  });

  it("Google の窓を閉じただけなら、失敗にしない", async () => {
    const { client } = setup();
    firebaseAuth.failWith = { signInWithPopup: "auth/popup-closed-by-user" };

    await expect(client.signInWithGoogle()).resolves.toBeUndefined();
  });

  it("別の方法で登録したメールアドレスで Google を使うと、その旨の失敗にする", async () => {
    const { client } = setup();
    firebaseAuth.failWith = { signInWithPopup: "auth/account-exists-with-different-credential" };

    await expect(client.signInWithGoogle()).rejects.toMatchObject({ failure: "other_method" });
  });

  it("パスワードの人は、確かめ直してから旅とアカウントを消す", async () => {
    firebaseAuth.currentUser = passwordUser("user-1");
    const { client, users, ready } = setup();
    await ready();

    await client.deleteEverything("long-password");

    expect(firebaseAuth.steps).toEqual([
      "reauthenticateWithCredential",
      "/api/me/trips",
      "deleteUser",
    ]);
    expect(users.at(-1)).toBeNull();
  });

  it("Google の人は、通信の前に確かめ直しの窓を開く", async () => {
    firebaseAuth.currentUser = {
      ...passwordUser("user-1"),
      providerData: [{ providerId: "google.com" }],
    };
    const { client, ready } = setup();
    await ready();

    await client.deleteEverything();

    expect(firebaseAuth.steps).toEqual(["reauthenticateWithPopup", "/api/me/trips", "deleteUser"]);
  });

  it.each([
    ["パスワードが違う", "auth/wrong-password", "reauthenticateWithCredential", "credentials"],
    ["ブラウザに止められた", "auth/popup-blocked", "reauthenticateWithPopup", "popup_blocked"],
    ["窓を閉じた", "auth/popup-closed-by-user", "reauthenticateWithPopup", "cancelled"],
  ])("確かめ直しに失敗したら（%s）、何も消さない", async (_name, code, where, failure) => {
    firebaseAuth.currentUser = {
      ...passwordUser("user-1"),
      providerData: [
        { providerId: where === "reauthenticateWithPopup" ? "google.com" : "password" },
      ],
    };
    firebaseAuth.failWith = { [where]: code };
    const { client, ready } = setup();
    await ready();

    await expect(client.deleteEverything("wrong-password")).rejects.toMatchObject({ failure });

    expect(firebaseAuth.steps).toEqual([where]);
  });

  it("パスワードを入れなければ、確かめ直しに進まない", async () => {
    firebaseAuth.currentUser = passwordUser("user-1");
    const { client, ready } = setup();
    await ready();

    await expect(client.deleteEverything()).rejects.toMatchObject({ failure: "credentials" });

    expect(firebaseAuth.steps).toEqual([]);
  });

  it("サーバーが旅を消せなければ、アカウントは消さない", async () => {
    firebaseAuth.currentUser = passwordUser("user-1");
    const { client, ready } = setup(() =>
      json({ code: "internal", message: "エラーです。", retryable: true }, 500),
    );
    await ready();

    await expect(client.deleteEverything("long-password")).rejects.toBeInstanceOf(TransportError);

    expect(firebaseAuth.steps).not.toContain("deleteUser");
  });

  it("お試し用のアカウントは、パスワードの変更とアカウントの削除を断る", async () => {
    firebaseAuth.currentUser = passwordUser(TRIAL_ACCOUNT_UID);
    const { client, users, ready } = setup();
    await ready();

    expect(users.at(-1)).toMatchObject({ trial: true });
    await expect(client.changePassword()).rejects.toMatchObject({ failure: "trial" });
    await expect(client.deleteEverything("long-password")).rejects.toMatchObject({
      failure: "trial",
    });

    expect(firebaseAuth.steps).toEqual([]);
  });

  it("ログイン中の人は、パスワードを変えるメールを頼める", async () => {
    firebaseAuth.currentUser = passwordUser("user-1");
    const { client, ready } = setup();
    await ready();

    await client.changePassword();

    expect(firebaseAuth.steps).toEqual(["sendPasswordResetEmail"]);
  });
});

describe("watchUserLeaving", () => {
  const user = (id: string): AccountUser => ({ id, name: null, usesPassword: true, trial: false });

  it("ログインしていた人がいなくなったときだけ知らせる", () => {
    const left = vi.fn();
    const onUser = watchUserLeaving(left);

    onUser(null);
    onUser(user("a"));
    onUser(user("a"));
    expect(left).not.toHaveBeenCalled();

    onUser(null);
    expect(left).toHaveBeenCalledTimes(1);

    onUser(user("a"));
    onUser(user("b"));
    expect(left).toHaveBeenCalledTimes(2);
  });
});
