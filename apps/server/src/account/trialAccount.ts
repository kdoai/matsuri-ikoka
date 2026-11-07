import { randomBytes } from "node:crypto";
import { TRIAL_ACCOUNT_UID } from "@matsuri-ikoka/schema";
import type { OwnerTripStorage } from "../storage/types";

// お試し用のアカウント（docs/spec/account.md）。何人かで同じメールアドレスとパスワードを使う。
// 作成・初期化・パスワードの作り直しは、scripts/trial-account.ts から人が実行する。
// パスワードは実行のときに乱数で作り、呼び出し元に返すだけで、どこにも残さない。

/** Firebase の Admin SDK のうち、ここで使う部分 */
export interface TrialAuthAdmin {
  getUser(uid: string): Promise<unknown>;
  createUser(properties: {
    uid: string;
    email: string;
    password: string;
    emailVerified: boolean;
  }): Promise<unknown>;
  updateUser(
    uid: string,
    properties: { email?: string; password?: string; disabled?: boolean; emailVerified?: boolean },
  ): Promise<unknown>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

export class TrialAccountError extends Error {}

/** 推測できない長さのパスワード（24バイトの乱数） */
export function newTrialPassword(): string {
  return randomBytes(24).toString("base64url");
}

async function exists(auth: TrialAuthAdmin): Promise<boolean> {
  try {
    await auth.getUser(TRIAL_ACCOUNT_UID);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "auth/user-not-found") return false;
    throw error;
  }
}

/**
 * アカウントを作り、パスワードを返す。もうあれば何も変えずに断る（配ったパスワードを無効にしない）。
 * だれかに消されても、同じ ID で作り直せば、残した旅はそのまま読める
 */
export async function createTrialAccount(auth: TrialAuthAdmin, email: string): Promise<string> {
  if (await exists(auth)) {
    throw new TrialAccountError(
      "お試し用のアカウントはもうあります。パスワードを作り直すなら rotate-password を使います",
    );
  }
  const password = newTrialPassword();
  await auth.createUser({ uid: TRIAL_ACCOUNT_UID, email, password, emailVerified: true });
  return password;
}

/** パスワードを作り直して返す。ログインしている人は、次の更新でログアウトする */
export async function rotateTrialPassword(auth: TrialAuthAdmin): Promise<string> {
  if (!(await exists(auth))) {
    throw new TrialAccountError("お試し用のアカウントがありません。先に create を実行します");
  }
  const password = newTrialPassword();
  await auth.updateUser(TRIAL_ACCOUNT_UID, { password });
  await auth.revokeRefreshTokens(TRIAL_ACCOUNT_UID);
  return password;
}

/**
 * 初期の状態に戻す。残した旅・共有・ガイドのデータ・相談の途中の状態を消し、
 * メールアドレスとログインできる状態を元に戻す。パスワードは変えない。消した、残した旅の数を返す
 */
export async function resetTrialAccount(
  auth: TrialAuthAdmin,
  trips: OwnerTripStorage,
  email: string,
): Promise<number> {
  if (!(await exists(auth))) {
    throw new TrialAccountError("お試し用のアカウントがありません。先に create を実行します");
  }
  await auth.updateUser(TRIAL_ACCOUNT_UID, { email, emailVerified: true, disabled: false });
  return trips.deleteAllTrips();
}
