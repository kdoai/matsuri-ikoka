import { describe, expect, it } from "vitest";
import source from "./AccountMenu.tsx?raw";
import { ACCOUNT_MENU_BUTTON } from "./accountMenuEntry";
import { latestOnly } from "./latestOnly";

describe("ログインの入口を外から開く", () => {
  it("入口のボタンの目印が AccountMenu にある", () => {
    expect(ACCOUNT_MENU_BUTTON).toContain('data-testid="account-menu"');
    expect(source).toContain('data-testid="account-menu"');
    expect(source).toContain('aria-controls="account-panel"');
  });
});

describe("latestOnly", () => {
  it("いちばん新しい頼みの応答だけを受け取る（ログアウトの前の一覧を出さない）", () => {
    const latest = latestOnly();
    const before = latest.next();
    const after = latest.next();
    expect(latest.isCurrent(before)).toBe(false);
    expect(latest.isCurrent(after)).toBe(true);
  });
});
