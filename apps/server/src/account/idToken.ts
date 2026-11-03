import type { Context } from "hono";

// ログインした利用者を、Firebase の ID トークン（Authorization: Bearer …）で決める。
// トークンを確かめるのはサーバーだけ。画面から送られた利用者の ID は使わない。

export interface IdTokenVerifier {
  /** 確かめられたら利用者の ID、だめなら null */
  verify(token: string): Promise<string | null>;
}

/** ID トークンの長さの上限（Firebase の ID トークンは 1〜2KB ほど） */
const MAX_TOKEN_LENGTH = 4096;

/** Authorization ヘッダーの Bearer のトークン。なければ null */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header?.trim() ?? "");
  const token = match?.[1];
  return token !== undefined && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/** 要求の利用者の ID。トークンがない・確かめられなければ null */
export async function requestUid(c: Context, verifier: IdTokenVerifier): Promise<string | null> {
  const token = bearerToken(c.req.header("authorization"));
  return token === null ? null : verifier.verify(token);
}
