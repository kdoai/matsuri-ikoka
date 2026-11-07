import { TRIAL_ACCOUNT_UID } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { MemoryTripStorage } from "../storage/memory";
import { ownerIdOf } from "../storage/owner";
import { createIdTokenVerifier } from "./firebase";
import {
  createTrialAccount,
  resetTrialAccount,
  rotateTrialPassword,
  TrialAccountError,
  type TrialAuthAdmin,
  trialTokenAccepted,
} from "./trialAccount";

const TRIAL_OWNER = ownerIdOf(TRIAL_ACCOUNT_UID);
const NOW = Date.UTC(2026, 10, 7);

const EMAIL = "trial@example.com";

/** ネットワークに出ない Admin SDK の代わり */
function fakeAuth() {
  const users = new Map<string, Record<string, unknown>>();
  const revoked: string[] = [];
  const invalidated: number[] = [];
  const state = {
    invalidateLogins: async (at: number) => {
      invalidated.push(at);
    },
  };
  const auth: TrialAuthAdmin = {
    async getUser(uid) {
      const user = users.get(uid);
      if (user === undefined) throw Object.assign(new Error("no"), { code: "auth/user-not-found" });
      return { providerData: (user.providers as string[]).map((providerId) => ({ providerId })) };
    },
    async createUser({ uid, ...rest }) {
      users.set(uid, { ...rest, providers: ["password"] });
      return rest;
    },
    async updateUser(uid, { providersToUnlink, ...properties }) {
      const user = users.get(uid) ?? {};
      const providers = (user.providers as string[]).filter(
        (id) => !providersToUnlink?.includes(id),
      );
      if (properties.password !== undefined && !providers.includes("password")) {
        providers.push("password");
      }
      users.set(uid, { ...user, ...properties, providers });
      return users.get(uid);
    },
    async revokeRefreshTokens(uid) {
      revoked.push(uid);
    },
  };
  return { auth, users, revoked, invalidated, state };
}

/** お試し用のアカウントに、だれかが Google と名前を結びつけた状態にする */
function linkGoogle(users: Map<string, Record<string, unknown>>) {
  users.set(TRIAL_ACCOUNT_UID, {
    ...users.get(TRIAL_ACCOUNT_UID),
    providers: ["password", "google.com"],
    displayName: "だれか",
    photoURL: "https://example.com/a.png",
  });
}

describe("お試し用のアカウント", () => {
  it("決まった ID で作り、作るたびに違う、十分に長いパスワードを返す", async () => {
    const first = fakeAuth();
    const second = fakeAuth();

    const a = await createTrialAccount(first.auth, EMAIL);
    const b = await createTrialAccount(second.auth, EMAIL);

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(first.users.get(TRIAL_ACCOUNT_UID)).toMatchObject({ email: EMAIL, password: a });
  });

  it("もうあれば作り直さず、配ったパスワードを変えない", async () => {
    const { auth, users } = fakeAuth();
    const password = await createTrialAccount(auth, EMAIL);

    await expect(createTrialAccount(auth, EMAIL)).rejects.toBeInstanceOf(TrialAccountError);

    expect(users.get(TRIAL_ACCOUNT_UID)?.password).toBe(password);
  });

  it("メールアドレスをほかのアカウントに取られていたら、次にすることを案内する", async () => {
    const { auth } = fakeAuth();
    auth.createUser = async () => {
      throw Object.assign(new Error("taken"), { code: "auth/email-already-exists" });
    };

    await expect(createTrialAccount(auth, EMAIL)).rejects.toThrow("ほかのアカウントが使っています");
  });

  it("パスワードを作り直すと、結びつけたものを外し、ログインしている人も外す", async () => {
    const { auth, users, revoked, invalidated, state } = fakeAuth();
    const before = await createTrialAccount(auth, EMAIL);
    linkGoogle(users);

    const after = await rotateTrialPassword(auth, state, () => NOW);

    expect(after).not.toBe(before);
    expect(users.get(TRIAL_ACCOUNT_UID)).toMatchObject({
      password: after,
      providers: ["password"],
      displayName: null,
      photoURL: null,
    });
    expect(revoked).toEqual([TRIAL_ACCOUNT_UID]);
    expect(invalidated).toEqual([NOW]);
  });

  it("アカウントがなければ、作り直しも初期化も断る", async () => {
    const { auth, state } = fakeAuth();
    const trips = new MemoryTripStorage().forOwner(TRIAL_OWNER);

    await expect(rotateTrialPassword(auth, state)).rejects.toBeInstanceOf(TrialAccountError);
    await expect(resetTrialAccount(auth, trips, state, EMAIL)).rejects.toBeInstanceOf(
      TrialAccountError,
    );
  });

  it("初期化すると、お試し用の旅だけが消え、結びつけたものとログインが外れ、パスワードは変わらない", async () => {
    const { auth, users, revoked, invalidated, state } = fakeAuth();
    const password = await createTrialAccount(auth, EMAIL);
    await auth.updateUser(TRIAL_ACCOUNT_UID, { email: "changed@example.com", disabled: true });
    linkGoogle(users);
    const storage = new MemoryTripStorage();
    const trial = storage.forOwner(TRIAL_OWNER);
    const other = storage.forOwner(ownerIdOf("someone"));
    const trialTrip = { ...fictionalItinerary(), id: "trip-trial" };
    const otherTrip = { ...fictionalItinerary(), id: "trip-other" };
    await storage.saveItinerary(trialTrip, TRIAL_OWNER);
    await storage.saveItinerary(otherTrip, ownerIdOf("someone"));
    await trial.claimTrip(trialTrip.id);
    await other.claimTrip(otherTrip.id);

    expect(await resetTrialAccount(auth, trial, state, EMAIL, () => NOW)).toEqual({
      deleted: 1,
      hasPassword: true,
    });

    expect(await trial.listTrips()).toEqual([]);
    expect((await other.listTrips()).map((trip) => trip.itineraryId)).toEqual(["trip-other"]);
    expect(users.get(TRIAL_ACCOUNT_UID)).toMatchObject({
      email: EMAIL,
      disabled: false,
      password,
      providers: ["password"],
      displayName: null,
    });
    expect(revoked).toEqual([TRIAL_ACCOUNT_UID]);
    expect(invalidated).toEqual([NOW]);
  });

  it("パスワードを外されていたら、初期化の結果で分かる", async () => {
    const { auth, users, state } = fakeAuth();
    await createTrialAccount(auth, EMAIL);
    users.set(TRIAL_ACCOUNT_UID, { ...users.get(TRIAL_ACCOUNT_UID), providers: ["google.com"] });
    const trips = new MemoryTripStorage().forOwner(TRIAL_OWNER);

    expect((await resetTrialAccount(auth, trips, state, EMAIL)).hasPassword).toBe(false);
  });
});

describe("お試し用のアカウントのトークン", () => {
  const token = (provider: string, authTime: number) => ({
    auth_time: authTime,
    firebase: { sign_in_provider: provider },
  });
  const at = Math.floor(NOW / 1000);

  it("パスワードでのログインだけを通す", () => {
    expect(trialTokenAccepted(token("password", at), null)).toBe(true);
    expect(trialTokenAccepted(token("google.com", at), null)).toBe(false);
  });

  it("無効にした時刻より前のログインは断り、同じ秒のログインは通す", () => {
    expect(trialTokenAccepted(token("password", at - 1), NOW)).toBe(false);
    expect(trialTokenAccepted(token("password", at), NOW + 500)).toBe(true);
    expect(trialTokenAccepted(token("password", at + 1), NOW)).toBe(true);
  });

  it("ふつうの利用者は方法によらず通し、時刻を読まない", async () => {
    let reads = 0;
    const verifier = createIdTokenVerifier(
      async (value) => ({ uid: value, ...token("google.com", at) }),
      async () => {
        reads += 1;
        return NOW + 60_000;
      },
    );

    expect(await verifier.verify("user-1")).toBe("user-1");
    expect(reads).toBe(0);
  });

  it("お試し用は、結びつけた方法・古いログイン・時刻を読めないときに断る", async () => {
    const verifierOf = (provider: string, authTime: number, validAfter: () => Promise<number>) =>
      createIdTokenVerifier(
        async () => ({ uid: TRIAL_ACCOUNT_UID, ...token(provider, authTime) }),
        validAfter,
      );

    expect(await verifierOf("password", at, async () => NOW).verify("t")).toBe(TRIAL_ACCOUNT_UID);
    expect(await verifierOf("google.com", at, async () => NOW).verify("t")).toBeNull();
    expect(await verifierOf("password", at - 60, async () => NOW).verify("t")).toBeNull();
    const failing = verifierOf("password", at, async () => {
      throw new Error("読めない");
    });
    expect(await failing.verify("t")).toBeNull();
  });
});
