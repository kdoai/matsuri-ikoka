import { expect, type Page, test } from "@playwright/test";
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

async function fakeFirebase(page: Page, uid: string) {
  const posted: string[] = [];
  await page.route("**/api/auth/config", (route) => route.fulfill({ json: CONFIG }));
  await page.route("https://identitytoolkit.googleapis.com/**", async (route) => {
    const url = new URL(route.request().url());
    const action = url.pathname.split("/").at(-1) ?? "";
    posted.push(action);
    const body = route.request().postDataJSON() as { email?: string; password?: string };
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
