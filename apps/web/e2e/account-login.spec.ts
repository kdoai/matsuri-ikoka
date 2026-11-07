import { expect, type Locator, type Page, test } from "@playwright/test";
import { enterShop } from "./helpers";

// ログインの窓を、本物の Firebase の部品で通す。Firebase の通信だけを偽物に置き換え、外には出ない。
// 接客サーバーはログインを用意していない（mock）ので、設定の応答だけを置き換える。

const CONFIG = {
  enabled: true,
  apiKey: "demo-api-key",
  authDomain: "example.com",
  projectId: "demo-project",
};

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** 形だけの ID トークン。部品は中の期限と利用者の ID だけを読む */
function fakeIdToken(uid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://securetoken.google.com/demo-project",
    aud: "demo-project",
    sub: uid,
    user_id: uid,
    iat: now,
    exp: now + 3600,
  };
  return `${base64Url({ alg: "none" })}.${base64Url(payload)}.signature`;
}

const TRIP = (index: number) => ({
  itineraryId: `trip-${index}`,
  title: `架空の旅 ${index}`,
  date: "2026-08-03",
  version: 1,
  updatedAt: "2026-08-01T00:00:00.000Z",
});

async function fakeFirebase(
  page: Page,
  uid: string,
  options: { trips?: number; deleteFails?: boolean } = {},
) {
  const posted: string[] = [];
  await page.route("**/api/auth/config", (route) => route.fulfill({ json: CONFIG }));
  await page.route("**/api/trips", (route) =>
    route.fulfill({
      json: { trips: Array.from({ length: options.trips ?? 0 }, (_, index) => TRIP(index + 1)) },
    }),
  );
  await page.route("**/api/me/trips", (route) => {
    posted.push("DELETE /api/me/trips");
    return route.fulfill({ json: { deleted: options.trips ?? 0 } });
  });
  await page.route("https://identitytoolkit.googleapis.com/**", async (route) => {
    const url = new URL(route.request().url());
    const action = url.pathname.split("/").at(-1) ?? "";
    posted.push(action);
    const body = route.request().postDataJSON() as { email?: string; password?: string };
    if (action === "accounts:delete") {
      return options.deleteFails
        ? route.fulfill({ status: 400, json: { error: { code: 400, message: "INTERNAL_ERROR" } } })
        : route.fulfill({ json: {} });
    }
    if (action === "accounts:signInWithPassword" && body.password !== "right-password") {
      return route.fulfill({
        status: 400,
        json: { error: { code: 400, message: "INVALID_LOGIN_CREDENTIALS" } },
      });
    }
    if (action === "accounts:signUp") {
      return route.fulfill({
        status: 400,
        json: { error: { code: 400, message: "EMAIL_EXISTS" } },
      });
    }
    if (action === "accounts:sendOobCode") {
      return route.fulfill({ json: { email: body.email } });
    }
    if (action === "accounts:lookup") {
      return route.fulfill({
        json: {
          users: [
            {
              localId: uid,
              email: "person@example.com",
              providerUserInfo: [{ providerId: "password", federatedId: "person@example.com" }],
              validSince: "1",
              lastLoginAt: "1",
              createdAt: "1",
            },
          ],
        },
      });
    }
    return route.fulfill({
      json: {
        localId: uid,
        email: "person@example.com",
        idToken: fakeIdToken(uid),
        refreshToken: "refresh",
        expiresIn: "3600",
        registered: true,
      },
    });
  });
  return posted;
}

async function openMenu(page: Page) {
  await page.getByRole("button", { name: "ログインと自分の旅" }).click();
  return page.getByRole("dialog", { name: "自分の旅" });
}

test.beforeEach(({ page: _page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
});

test("失敗の文からはメールアドレスの有無が分からず、再設定は登録の有無によらず同じ文を出す", async ({
  page,
}) => {
  await fakeFirebase(page, "user-1");
  await enterShop(page);
  const menu = await openMenu(page);

  await menu.getByLabel("メールアドレス").fill("person@example.com");
  await menu.getByLabel("パスワード").fill("wrong-password");
  await menu.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(menu.getByRole("alert")).toHaveText("メールアドレスかパスワードが違います。");

  await menu.getByRole("button", { name: "はじめての方は登録" }).click();
  await menu.getByLabel("パスワード").fill("long-enough-password");
  await menu.getByRole("button", { name: "登録する" }).click();
  await expect(menu.getByRole("alert")).toContainText("登録できませんでした");

  await menu.getByRole("button", { name: "パスワードを忘れたとき" }).click();
  await menu.getByRole("button", { name: "再設定のメールを送る" }).click();
  await expect(menu.getByRole("status")).toContainText("登録されていれば");
});

test("パスワードでログインし、ログアウトすると新しい相談を始める", async ({ page }) => {
  await fakeFirebase(page, "user-1");
  let sessions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/session") {
      sessions += 1;
    }
  });
  await enterShop(page);
  const menu = await openMenu(page);
  const started = sessions;

  await menu.getByLabel("メールアドレス").fill("person@example.com");
  await menu.getByLabel("パスワード").fill("right-password");
  await menu.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(menu.getByRole("button", { name: "ログアウト" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "パスワードを変える" })).toBeVisible();
  // ログインしただけでは、相談をやり直さない
  expect(sessions).toBe(started);

  await menu.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByRole("button", { name: "ログインと自分の旅" })).toBeVisible();
  await expect.poll(() => sessions).toBe(started + 1);
});

test("お試し用のアカウントには、パスワードの変更とアカウントの削除を出さない", async ({ page }) => {
  await fakeFirebase(page, "trial-account");
  await enterShop(page);
  const menu = await openMenu(page);

  await menu.getByLabel("メールアドレス").fill("person@example.com");
  await menu.getByLabel("パスワード").fill("right-password");
  await menu.getByRole("button", { name: "ログイン", exact: true }).click();

  await expect(menu.getByText("お試し用のアカウントです")).toBeVisible();
  await expect(menu.getByRole("button", { name: "ログアウト" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "パスワードを変える" })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: /すべて消す/ })).toHaveCount(0);
});

/** パスワードでログインする */
async function signIn(menu: Locator) {
  await menu.getByLabel("メールアドレス").fill("person@example.com");
  await menu.getByLabel("パスワード").fill("right-password");
  await menu.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(menu.getByRole("button", { name: "ログアウト" })).toBeVisible();
}

/** 要素が、いまの窓の中に収まっていることを測る（fill と click は overflow の中でも通るので、位置を見る） */
async function expectInsideWindow(page: Page, target: Locator) {
  const box = await target.boundingBox();
  const size = page.viewportSize();
  expect(box).not.toBeNull();
  expect(size).not.toBeNull();
  if (box === null || size === null) return;
  expect(box.x, "左").toBeGreaterThanOrEqual(0);
  expect(box.y, "上").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "右").toBeLessThanOrEqual(size.width);
  expect(box.y + box.height, "下").toBeLessThanOrEqual(size.height);
}

/** 窓の中の要素まで送ると、画面の中に見える */
async function expectReachable(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await expectInsideWindow(page, target);
}

for (const [width, height] of [
  [375, 812],
  [320, 568],
  [812, 375],
  [1280, 600],
] as const) {
  test(`${width}×${height} でも、ログインの窓と旅の一覧が画面に収まる`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await fakeFirebase(page, "user-1", { trips: 5 });
    await enterShop(page);
    const menu = await openMenu(page);

    await expectInsideWindow(page, menu);
    await expectReachable(page, menu.getByRole("button", { name: "閉じる" }));
    await expectReachable(page, menu.getByLabel("メールアドレス"));
    await expectReachable(page, menu.getByLabel("パスワード"));
    await expectReachable(page, menu.getByRole("button", { name: "パスワードを忘れたとき" }));

    await signIn(menu);
    await expectInsideWindow(page, menu);
    await menu.getByRole("button", { name: "旅とログインの記録をすべて消す" }).click();
    await expectInsideWindow(page, menu);
    await expectReachable(page, menu.getByRole("button", { name: "やめる" }));
    await expectReachable(page, menu.getByLabel(/パスワードを入れてください/));
  });
}

test("パスワードの人は、確かめ直してから旅とアカウントを消し、新しい相談を始める", async ({
  page,
}) => {
  const posted = await fakeFirebase(page, "user-1", { trips: 1 });
  let sessions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/session") {
      sessions += 1;
    }
  });
  await enterShop(page);
  const menu = await openMenu(page);
  await signIn(menu);
  const started = sessions;
  posted.length = 0;

  await menu.getByRole("button", { name: "旅とログインの記録をすべて消す" }).click();
  const confirm = menu.getByRole("button", { name: "すべて消す", exact: true });
  await expect(confirm).toBeDisabled();
  await menu.getByLabel(/パスワードを入れてください/).fill("wrong-password");
  await confirm.click();
  await expect(menu.getByRole("alert")).toHaveText("メールアドレスかパスワードが違います。");
  expect(posted).not.toContain("DELETE /api/me/trips");

  await menu.getByLabel(/パスワードを入れてください/).fill("right-password");
  await confirm.click();
  await expect(menu.getByLabel("メールアドレス")).toBeVisible();
  await expect(menu.getByRole("alert")).toHaveCount(0);

  const order = posted.filter((step) =>
    ["accounts:signInWithPassword", "DELETE /api/me/trips", "accounts:delete"].includes(step),
  );
  expect(order.slice(-3)).toEqual([
    "accounts:signInWithPassword",
    "DELETE /api/me/trips",
    "accounts:delete",
  ]);
  await expect.poll(() => sessions).toBe(started + 1);
});

test("旅を消したあとにアカウントを消せなければ、そう伝え、前の旅程を残さず新しい相談を始める", async ({
  page,
}) => {
  await fakeFirebase(page, "user-1", { deleteFails: true });
  let sessions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/session") {
      sessions += 1;
    }
  });
  await enterShop(page);
  const menu = await openMenu(page);
  await signIn(menu);
  const started = sessions;

  await menu.getByRole("button", { name: "旅とログインの記録をすべて消す" }).click();
  await menu.getByLabel(/パスワードを入れてください/).fill("right-password");
  await menu.getByRole("button", { name: "すべて消す", exact: true }).click();

  await expect(menu.getByRole("alert")).toContainText("ログインの記録を消せませんでした");
  await expect.poll(() => sessions).toBe(started + 1);
});
