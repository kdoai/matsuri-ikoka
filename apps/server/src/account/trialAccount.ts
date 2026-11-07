import { randomBytes } from "node:crypto";
import { TRIAL_ACCOUNT_UID } from "@matsuri-ikoka/schema";
import type { OwnerTripStorage } from "../storage/types";

// お試し用のアカウント（docs/spec/account.md）。何人かで同じメールアドレスとパスワードを使う。
// 作成・初期化・パスワードの作り直しは、scripts/trial-account.ts から人が実行する。
// パスワードは実行のときに乱数で作り、呼び出し元に返すだけで、どこにも残さない。

/**
 * お試し用のアカウントの状態の文書。validAfter（ミリ秒）より前のログインは無効にする。
 * トークンの取り消しを確かめる Admin SDK の checkRevoked には Auth の読み取りの権限が要るので、
 * 実行用のアカウントに権限を足さず、ここに書いた時刻で断る
 */
export const TRIAL_STATE_DOC = "accountState/trial";

/** Firebase の Admin SDK のうち、ここで使う部分 */
export interface TrialAuthAdmin {
  getUser(uid: string): Promise<{ providerData: { providerId: string }[] }>;
  createUser(properties: {
    uid: string;
    email: string;
    password: string;
    emailVerified: boolean;
  }): Promise<unknown>;
  updateUser(
    uid: string,
    properties: {
      email?: string;
      password?: string;
      disabled?: boolean;
      emailVerified?: boolean;
      displayName?: null;
      photoURL?: null;
      providersToUnlink?: string[];
    },
  ): Promise<unknown>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

/** お試し用のアカウントの状態の書き込み */
export interface TrialState {
  /** この時刻（ミリ秒）より前のログインを無効にする */
  invalidateLogins(validAfter: number): Promise<void>;
}

export class TrialAccountError extends Error {}

const PASSWORD_PROVIDER = "password";

/** 推測できない長さのパスワード（24バイトの乱数） */
export function newTrialPassword(): string {
  return randomBytes(24).toString("base64url");
}

/** ID トークンのうち、お試し用のアカウントで確かめる部分 */
export interface TrialToken {
  auth_time: number;
  firebase: { sign_in_provider: string };
}

/**
 * お試し用のアカウントのトークンを通してよいか。パスワードでのログインだけを通す
 * （結びつけた Google などでは入れない）。無効にした時刻より前のログインも断る。
 * auth_time は秒なので、秒にそろえて比べる
 */
export function trialTokenAccepted(token: TrialToken, validAfter: number | null): boolean {
  if (token.firebase.sign_in_provider !== PASSWORD_PROVIDER) return false;
  return validAfter === null || token.auth_time >= Math.floor(validAfter / 1000);
}

async function find(
  auth: TrialAuthAdmin,
): Promise<{ providerData: { providerId: string }[] } | null> {
  try {
    return await auth.getUser(TRIAL_ACCOUNT_UID);
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") return null;
    throw error;
  }
}

async function required(auth: TrialAuthAdmin) {
  const user = await find(auth);
  if (user === null) {
    throw new TrialAccountError("お試し用のアカウントがありません。先に create を実行します");
  }
  return user;
}

/** メールアドレスをほかのアカウントに取られていたら、次にすることを案内する */
async function withEmailGuide<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if ((error as { code?: string }).code === "auth/email-already-exists") {
      throw new TrialAccountError(
        "このメールアドレスは、ほかのアカウントが使っています。TRIAL_ACCOUNT_EMAIL に別のメールアドレスを渡すか、Firebase のコンソールでそのアカウントを消してから、もう一度実行します",
      );
    }
    throw error;
  }
}

/** ログインと結びつけたもの（Google など）と、名前と写真を外す。パスワードは外さない */
function withoutLinks(user: { providerData: { providerId: string }[] }) {
  const providersToUnlink = user.providerData
    .map((provider) => provider.providerId)
    .filter((id) => id !== PASSWORD_PROVIDER);
  return {
    displayName: null,
    photoURL: null,
    ...(providersToUnlink.length === 0 ? {} : { providersToUnlink }),
  };
}

/** ログインしている人を外す。次の更新でログアウトし、それまでのトークンもサーバーが断る */
async function endLogins(
  auth: TrialAuthAdmin,
  state: TrialState,
  now: () => number,
): Promise<void> {
  await auth.revokeRefreshTokens(TRIAL_ACCOUNT_UID);
  await state.invalidateLogins(now());
}

/**
 * アカウントを作り、パスワードを返す。もうあれば何も変えずに断る（配ったパスワードを無効にしない）。
 * だれかに消されても、同じ ID で作り直せば、残した旅はそのまま読める
 */
export async function createTrialAccount(auth: TrialAuthAdmin, email: string): Promise<string> {
  if ((await find(auth)) !== null) {
    throw new TrialAccountError(
      "お試し用のアカウントはもうあります。パスワードを作り直すなら rotate-password を使います",
    );
  }
  const password = newTrialPassword();
  await withEmailGuide(() =>
    auth.createUser({ uid: TRIAL_ACCOUNT_UID, email, password, emailVerified: true }),
  );
  return password;
}

/** パスワードを作り直して返す。結びつけたものを外し、ログインしている人も外す */
export async function rotateTrialPassword(
  auth: TrialAuthAdmin,
  state: TrialState,
  now: () => number = Date.now,
): Promise<string> {
  const user = await required(auth);
  const password = newTrialPassword();
  await auth.updateUser(TRIAL_ACCOUNT_UID, { ...withoutLinks(user), password, disabled: false });
  await endLogins(auth, state, now);
  return password;
}

/**
 * 初期の状態に戻す。残した旅・共有・ガイドのデータ・相談の途中の状態を消し、
 * 結びつけたものを外し、メールアドレスとログインできる状態を戻し、ログインしている人を外す。
 * パスワードは変えない。消した、残した旅の数と、パスワードが残っているかを返す
 */
export async function resetTrialAccount(
  auth: TrialAuthAdmin,
  trips: OwnerTripStorage,
  state: TrialState,
  email: string,
  now: () => number = Date.now,
): Promise<{ deleted: number; hasPassword: boolean }> {
  const user = await required(auth);
  await withEmailGuide(() =>
    auth.updateUser(TRIAL_ACCOUNT_UID, {
      ...withoutLinks(user),
      email,
      emailVerified: true,
      disabled: false,
    }),
  );
  await endLogins(auth, state, now);
  const deleted = await trips.deleteAllTrips();
  return {
    deleted,
    hasPassword: user.providerData.some((provider) => provider.providerId === PASSWORD_PROVIDER),
  };
}
