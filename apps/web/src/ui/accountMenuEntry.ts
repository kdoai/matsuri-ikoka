// ログインと自分の旅の入口（AccountMenu）を、部品の外から開く。
// 入口の開閉は AccountMenu の中だけが持っているので、入口のボタンを押す形にしている。
// ボタンの目印を変えると開けなくなるので、accountMenuEntry.test.ts で確かめる。

export const ACCOUNT_MENU_BUTTON =
  '[data-testid="account-menu"] button[aria-controls="account-panel"]';

export function openAccountMenu(): void {
  document.querySelector<HTMLButtonElement>(ACCOUNT_MENU_BUTTON)?.click();
}
