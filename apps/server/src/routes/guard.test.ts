import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { PASSCODE_HEADER, passcodeGuard } from "./guard";

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
