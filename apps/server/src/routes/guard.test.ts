import { TRIAL_ACCOUNT_UID } from "@matsuri-ikoka/schema";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DailyLimiter, PASSCODE_HEADER, passcodeGuard, turnQuota } from "./guard";

// 合言葉の入口。値はテストのためだけのもの。

const PASSCODE = "fictional-passcode";

function guarded(passcode: string | null) {
  const app = new Hono();
  app.use("*", passcodeGuard(passcode));
  app.get("/", (c) => c.text("ok"));
  return (given?: string) =>
    app.request("/", given === undefined ? {} : { headers: { [PASSCODE_HEADER]: given } });
}

describe("passcodeGuard", () => {
  it("合言葉が合えば通す", async () => {
    expect((await guarded(PASSCODE)(PASSCODE)).status).toBe(200);
  });

  it.each([
    ["ヘッダーがない", undefined],
    ["空", ""],
    ["同じ長さで違う", "fictional-passcodf"],
    ["前の部分だけが合う", "fictional-passcod"],
    ["後ろに文字を足した", `${PASSCODE}x`],
    ["先頭だけが違う", `x${PASSCODE}`],
    ["ASCII でない文字を足した", `${PASSCODE}é`],
    ["大文字と小文字が違う", PASSCODE.toUpperCase()],
  ])("%sときは 401 で断る", async (_name, given) => {
    const res = await guarded(PASSCODE)(given);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("合言葉を設定していなければ、確かめずに通す", async () => {
    expect((await guarded(null)()).status).toBe(200);
    expect((await guarded(null)("anything")).status).toBe(200);
  });
});

describe("turnQuota", () => {
  const day = () => "2026-08-03";

  it("ログインしている人は、利用者と IP の両方で数える", () => {
    const clientLimiter = new DailyLimiter(1, day);
    const limits = { limiter: new DailyLimiter(null, day), clientLimiter };

    const first = turnQuota(limits, "alice", "203.0.113.1");
    expect(first.client).toBe("uid:alice");
    expect(first.allows()).toBe(true);
    first.consume();

    expect(turnQuota(limits, "alice", "203.0.113.2").allows()).toBe(false);
    expect(turnQuota(limits, "bob", "203.0.113.1").allows()).toBe(false);
    expect(turnQuota(limits, null, "203.0.113.1").allows()).toBe(false);
    expect(turnQuota(limits, "bob", "203.0.113.3").allows()).toBe(true);
  });

  it("お試し用のアカウントは IP で数え、全体はお試し用の枠で数える", () => {
    const limiter = new DailyLimiter(1, day);
    const trialLimiter = new DailyLimiter(2, day);
    const clientLimiter = new DailyLimiter(1, day);
    const limits = { limiter, trialLimiter, clientLimiter };

    const first = turnQuota(limits, TRIAL_ACCOUNT_UID, "203.0.113.1");
    expect(first.client).toBe("203.0.113.1");
    first.consume();

    expect(turnQuota(limits, TRIAL_ACCOUNT_UID, "203.0.113.1").allows()).toBe(false);
    expect(limiter.allows()).toBe(true);
    const second = turnQuota(limits, TRIAL_ACCOUNT_UID, "203.0.113.2");
    expect(second.allows()).toBe(true);
    second.consume();
    // お試し用の全体の枠を使い切っても、ほかの人の枠は残っている
    expect(turnQuota(limits, TRIAL_ACCOUNT_UID, "203.0.113.3").allows()).toBe(false);
    expect(turnQuota(limits, "alice", "203.0.113.3").allows()).toBe(true);
  });

  it("お試し用の枠がなければ、全体の枠で数える", () => {
    const limiter = new DailyLimiter(1, day);
    turnQuota({ limiter }, TRIAL_ACCOUNT_UID, "203.0.113.1").consume();

    expect(limiter.allows()).toBe(false);
  });
});
