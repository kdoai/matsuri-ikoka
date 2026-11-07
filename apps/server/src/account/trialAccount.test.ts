import { TRIAL_ACCOUNT_UID } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { MemoryTripStorage } from "../storage/memory";
import { ownerIdOf } from "../storage/owner";
import { TRIAL_OWNER } from "./idToken";
import {
  createTrialAccount,
  resetTrialAccount,
  rotateTrialPassword,
  TrialAccountError,
  type TrialAuthAdmin,
} from "./trialAccount";

const EMAIL = "trial@example.com";

/** ネットワークに出ない Admin SDK の代わり */
function fakeAuth() {
  const users = new Map<string, Record<string, unknown>>();
  const revoked: string[] = [];
  const auth: TrialAuthAdmin = {
    async getUser(uid) {
      const user = users.get(uid);
      if (user === undefined) throw Object.assign(new Error("no"), { code: "auth/user-not-found" });
      return user;
    },
    async createUser({ uid, ...rest }) {
      users.set(uid, rest);
      return rest;
    },
    async updateUser(uid, properties) {
      users.set(uid, { ...users.get(uid), ...properties });
      return users.get(uid);
    },
    async revokeRefreshTokens(uid) {
      revoked.push(uid);
    },
  };
  return { auth, users, revoked };
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

  it("パスワードを作り直すと、ログインしている人のトークンも無効にする", async () => {
    const { auth, users, revoked } = fakeAuth();
    const before = await createTrialAccount(auth, EMAIL);

    const after = await rotateTrialPassword(auth);

    expect(after).not.toBe(before);
    expect(users.get(TRIAL_ACCOUNT_UID)?.password).toBe(after);
    expect(revoked).toEqual([TRIAL_ACCOUNT_UID]);
  });

  it("アカウントがなければ、作り直しも初期化も断る", async () => {
    const { auth } = fakeAuth();
    const trips = new MemoryTripStorage().forOwner(TRIAL_OWNER);

    await expect(rotateTrialPassword(auth)).rejects.toBeInstanceOf(TrialAccountError);
    await expect(resetTrialAccount(auth, trips, EMAIL)).rejects.toBeInstanceOf(TrialAccountError);
  });

  it("初期化すると、お試し用の旅だけが消え、変えられたメールアドレスが戻り、パスワードは変わらない", async () => {
    const { auth, users } = fakeAuth();
    const password = await createTrialAccount(auth, EMAIL);
    await auth.updateUser(TRIAL_ACCOUNT_UID, { email: "changed@example.com", disabled: true });
    const storage = new MemoryTripStorage();
    const trial = storage.forOwner(TRIAL_OWNER);
    const other = storage.forOwner(ownerIdOf("someone"));
    const trialTrip = { ...fictionalItinerary(), id: "trip-trial" };
    const otherTrip = { ...fictionalItinerary(), id: "trip-other" };
    await storage.saveItinerary(trialTrip, TRIAL_OWNER);
    await storage.saveItinerary(otherTrip, ownerIdOf("someone"));
    await trial.claimTrip(trialTrip.id);
    await other.claimTrip(otherTrip.id);

    expect(await resetTrialAccount(auth, trial, EMAIL)).toBe(1);

    expect(await trial.listTrips()).toEqual([]);
    expect((await other.listTrips()).map((trip) => trip.itineraryId)).toEqual(["trip-other"]);
    expect(users.get(TRIAL_ACCOUNT_UID)).toMatchObject({ email: EMAIL, disabled: false, password });
  });
});
