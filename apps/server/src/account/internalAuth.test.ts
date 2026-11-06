import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createInternalVerifiers,
  createOidcVerifier,
  createSignatureVerifier,
  type InternalVerifier,
  type OidcTokenReader,
  readInternalAuthConfig,
} from "./internalAuth";

// 内部の入口の検証。ネットワークには出ない。鍵と値はテストのためだけのもの。

async function verified(verifier: InternalVerifier, init: RequestInit) {
  const app = new Hono();
  let result: unknown;
  app.post("/internal/tick", async (c: Context) => {
    result = await verifier.verify(c);
    // 確かめたあとでも本文を読める
    return c.text(await c.req.text());
  });
  const res = await app.request("/internal/tick", { method: "POST", ...init });
  return { result, body: await res.text() };
}

describe("readInternalAuthConfig", () => {
  it("何も設定しなければ、どの検証も作らない", () => {
    const config = readInternalAuthConfig({});

    expect(config).toEqual({ oidc: null, webhookSigningKey: null });
    expect(createInternalVerifiers(config)).toEqual({});
  });

  it("OIDC は宛先と呼び出し元の両方がそろったときだけ使う", () => {
    expect(
      readInternalAuthConfig({ INTERNAL_OIDC_AUDIENCE: "https://example.com" }).oidc,
    ).toBeNull();
    expect(
      readInternalAuthConfig({ INTERNAL_OIDC_CALLER_EMAIL: "tick@example.com" }).oidc,
    ).toBeNull();
    const config = readInternalAuthConfig({
      INTERNAL_OIDC_AUDIENCE: "https://example.com",
      INTERNAL_OIDC_CALLER_EMAIL: "tick@example.com",
      ANTHROPIC_WEBHOOK_SIGNING_KEY: "whsec_a2V5",
    });

    expect(Object.keys(createInternalVerifiers(config)).sort()).toEqual(["oidc", "signature"]);
  });
});

describe("createOidcVerifier", () => {
  const config = { audience: "https://example.com/internal", callerEmail: "tick@example.com" };
  const bearer = { headers: { authorization: "Bearer token-abc" } };

  it("宛先を渡して確かめ、決めたサービスアカウントだけを通す", async () => {
    const read = vi.fn<OidcTokenReader>(async () => ({
      email: config.callerEmail,
      email_verified: true,
    }));

    const { result } = await verified(createOidcVerifier(config, read), bearer);

    expect(read).toHaveBeenCalledWith("token-abc", config.audience);
    expect(result).toEqual({ kind: "oidc", id: config.callerEmail });
  });

  it.each([
    ["別のサービスアカウント", { email: "other@example.com", email_verified: true }],
    ["確かめられていないメールアドレス", { email: "tick@example.com", email_verified: false }],
    ["メールアドレスのないトークン", {}],
    ["中身のないトークン", null],
  ])("%sは断る", async (_name, payload) => {
    const { result } = await verified(
      createOidcVerifier(config, async () => payload),
      bearer,
    );
    expect(result).toBeNull();
  });

  it("トークンがない・確かめに失敗したら断り、ログに文を残さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = createOidcVerifier(config, async () => {
      throw new Error("確かめられない：token-abc");
    });

    expect((await verified(failing, {})).result).toBeNull();
    expect((await verified(failing, bearer)).result).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("token-abc");
    warn.mockRestore();
  });
});

describe("createSignatureVerifier", () => {
  const key = Buffer.from("テストのための署名の鍵");
  const signingKey = `whsec_${key.toString("base64")}`;
  const nowMs = 1_800_000_000_000;
  const timestamp = String(nowMs / 1000);
  const body = '{"type":"event","id":"whe_1"}';
  const sign = (id: string, at: string, text: string) =>
    `v1,${createHmac("sha256", key).update(`${id}.${at}.${text}`).digest("base64")}`;
  const verifier = createSignatureVerifier(signingKey, { now: () => nowMs });
  const headers = (over: Record<string, string> = {}) => ({
    "webhook-id": "whe_1",
    "webhook-timestamp": timestamp,
    "webhook-signature": sign("whe_1", timestamp, body),
    ...over,
  });

  it("正しい署名を通し、配信の ID を呼び出し元にする。本文はあとからも読める", async () => {
    const { result, body: echoed } = await verified(verifier, { headers: headers(), body });

    expect(result).toEqual({ kind: "signature", id: "whe_1" });
    expect(echoed).toBe(body);
  });

  it("鍵を回したあとの、複数の署名のどれかが合えば通す", async () => {
    const signature = `v1,AAAA ${sign("whe_1", timestamp, body)}`;
    const { result } = await verified(verifier, {
      headers: headers({ "webhook-signature": signature }),
      body,
    });

    expect(result).toEqual({ kind: "signature", id: "whe_1" });
  });

  it.each([
    ["本文を変えた", headers(), `${body} `],
    ["配信の ID を変えた", headers({ "webhook-id": "whe_2" }), body],
    ["時刻を変えた", headers({ "webhook-timestamp": String(nowMs / 1000 + 1) }), body],
    ["形の違う署名", headers({ "webhook-signature": "v2,abc" }), body],
    ["形の違う時刻", headers({ "webhook-timestamp": "yesterday" }), body],
  ])("%sら断る", async (_name, requestHeaders, text) => {
    const { result } = await verified(verifier, { headers: requestHeaders, body: text });
    expect(result).toBeNull();
  });

  it("別の鍵の署名は断る", async () => {
    const other = createSignatureVerifier("whsec_ZGlmZmVyZW50", { now: () => nowMs });
    expect((await verified(other, { headers: headers(), body })).result).toBeNull();
  });

  it("5分より古い配信は、署名が正しくても断る", async () => {
    const stale = String(nowMs / 1000 - 5 * 60 - 1);
    const { result } = await verified(verifier, {
      headers: headers({
        "webhook-timestamp": stale,
        "webhook-signature": sign("whe_1", stale, body),
      }),
      body,
    });
    expect(result).toBeNull();
  });

  it("見出しが欠けていたら断る", async () => {
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const partial: Record<string, string> = headers();
      delete partial[name];
      expect((await verified(verifier, { headers: partial, body })).result).toBeNull();
    }
  });
});
