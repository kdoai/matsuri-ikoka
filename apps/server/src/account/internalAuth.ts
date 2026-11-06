import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { errorForLog } from "../log";
import { bearerToken } from "./idToken";

// 定期実行と Webhook が呼ぶ内部の入口の検証。合言葉やログインとは別の口にする（docs/spec/api.md の「内部の入口」）。
// - oidc：Cloud Scheduler などが付ける Google の OIDC トークン。宛先（audience）と、呼んでよいサービスアカウントを確かめる
// - signature：Managed Agents の Webhook の署名（Standard Webhooks の形。本文の生のバイトに対する HMAC-SHA256）
// 設定がなければ、その入口だけが断る。サーバーは起動し、相談はそのまま動く。

export type InternalAuthKind = "oidc" | "signature";

/** 確かめられた呼び出し元 */
export interface InternalCaller {
  kind: InternalAuthKind;
  /** 呼び出し元の名前（サービスアカウントのメールアドレス、Webhook の配信の ID） */
  id: string;
}

export interface InternalVerifier {
  /** 確かめられたら呼び出し元、だめなら null */
  verify(c: Context): Promise<InternalCaller | null>;
}

export type InternalVerifiers = Partial<Record<InternalAuthKind, InternalVerifier>>;

export interface InternalAuthConfig {
  oidc: { audience: string; callerEmail: string } | null;
  webhookSigningKey: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** 設定は片方だけでは使わない（宛先だけ、呼び出し元だけでは確かめたことにならない） */
export function readInternalAuthConfig(env: NodeJS.ProcessEnv): InternalAuthConfig {
  const audience = nonEmpty(env.INTERNAL_OIDC_AUDIENCE);
  const callerEmail = nonEmpty(env.INTERNAL_OIDC_CALLER_EMAIL);
  return {
    oidc: audience !== null && callerEmail !== null ? { audience, callerEmail } : null,
    webhookSigningKey: nonEmpty(env.ANTHROPIC_WEBHOOK_SIGNING_KEY),
  };
}

/** OIDC トークンの署名・期限・宛先を確かめて、中身を返す。だめなら例外か null */
export type OidcTokenReader = (
  token: string,
  audience: string,
) => Promise<{ email?: string | undefined; email_verified?: boolean | undefined } | null>;

/** Google の公開鍵で OIDC トークンを確かめる。読み込みに時間がかかるので、はじめて呼ばれたときに読み込む */
export const readGoogleOidcToken: OidcTokenReader = async (token, audience) => {
  const { OAuth2Client } = await import("google-auth-library");
  const ticket = await new OAuth2Client().verifyIdToken({ idToken: token, audience });
  return ticket.getPayload() ?? null;
};

export function createOidcVerifier(
  config: { audience: string; callerEmail: string },
  read: OidcTokenReader = readGoogleOidcToken,
): InternalVerifier {
  return {
    async verify(c) {
      const token = bearerToken(c.req.header("authorization"));
      if (token === null) return null;
      try {
        const payload = await read(token, config.audience);
        if (payload?.email !== config.callerEmail || payload.email_verified !== true) return null;
        return { kind: "oidc", id: payload.email };
      } catch (error) {
        console.warn(JSON.stringify({ kind: "internal_auth_failed", ...errorForLog(error) }));
        return null;
      }
    },
  };
}

/** 署名の鍵を戻す。`whsec_` を除いて base64 で読む */
function signingKeyBytes(signingKey: string): Buffer {
  return Buffer.from(signingKey.replace(/^whsec_/, ""), "base64");
}

/** 署名の時刻と今のずれの上限（秒）。古い配信の使い回しを防ぐ */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Webhook の署名を確かめる。webhook-signature には `v1,<base64>` が空白区切りで1つ以上入り、
 * `{webhook-id}.{webhook-timestamp}.{本文}` の HMAC-SHA256 のどれかが合えば通す。
 * 鍵は `whsec_` を除いて base64 で戻す
 */
export function createSignatureVerifier(
  signingKey: string,
  options: { now?: () => number } = {},
): InternalVerifier {
  const key = signingKeyBytes(signingKey);
  // 空の鍵の HMAC は、だれでも作れる
  if (key.length === 0) throw new Error("署名の鍵が空です");
  const now = options.now ?? Date.now;
  return {
    async verify(c) {
      const id = c.req.header("webhook-id");
      const timestamp = c.req.header("webhook-timestamp");
      const signatures = c.req.header("webhook-signature");
      if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp)) return null;
      if (Math.abs(now() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return null;
      const body = await c.req.text();
      const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
      const matched = signatures
        .split(" ")
        .some(
          (entry) =>
            entry.startsWith("v1,") && safeEqual(Buffer.from(entry.slice(3), "base64"), expected),
        );
      return matched ? { kind: "signature", id } : null;
    },
  };
}

/** 設定のある検証だけを作る。空の署名の鍵では検証を作らず、その入口だけが断る */
export function createInternalVerifiers(config: InternalAuthConfig): InternalVerifiers {
  const { webhookSigningKey } = config;
  const usableKey = webhookSigningKey !== null && signingKeyBytes(webhookSigningKey).length > 0;
  if (webhookSigningKey !== null && !usableKey) {
    console.warn(JSON.stringify({ kind: "internal_auth_key_unusable" }));
  }
  return {
    ...(config.oidc === null ? {} : { oidc: createOidcVerifier(config.oidc) }),
    ...(usableKey ? { signature: createSignatureVerifier(webhookSigningKey) } : {}),
  };
}
