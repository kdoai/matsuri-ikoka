import { TRIAL_ACCOUNT_UID } from "@matsuri-ikoka/schema";
import type { Context } from "hono";
import { type OwnerId, ownerIdOf } from "../storage/owner";

// ログインした利用者を、Firebase の ID トークン（Authorization: Bearer …）で決める。
// トークンを確かめるのはサーバーだけ。画面から送られた利用者の ID は使わない。

export interface IdTokenVerifier {
  /** 確かめられたら利用者の ID、だめなら null */
  verify(token: string): Promise<string | null>;
}

/** お試し用のアカウントの持ち主。初期化のスクリプトが、この人の旅だけを消すのに使う */
export const TRIAL_OWNER: OwnerId = ownerIdOf(TRIAL_ACCOUNT_UID);

/** ID トークンの長さの上限（Firebase の ID トークンは 1〜2KB ほど） */
const MAX_TOKEN_LENGTH = 4096;

/** Authorization ヘッダーの Bearer のトークン。なければ null */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header?.trim() ?? "");
  const token = match?.[1];
  return token !== undefined && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/**
 * 要求の利用者を、持ち主の ID にして返す。トークンがない・確かめられない・ログインを用意していなければ null。
 * 利用者のデータに触れるときの持ち主は、ここを通した値だけを使う
 */
export async function requestOwner(
  c: Context,
  verifier: IdTokenVerifier | null,
): Promise<OwnerId | null> {
  if (verifier === null) return null;
  const token = bearerToken(c.req.header("authorization"));
  if (token === null) return null;
  const uid = await verifier.verify(token);
  return uid === null ? null : ownerIdOf(uid);
}
