import { expect, type Page, test } from "@playwright/test";
import { chooseTripEntry, enterShop } from "./helpers";

// 日帰りのときは、どの道で日帰りに決めても、行き先の段階で片道の所要時間を選べる。
// 泊まりから日帰りに直したときも同じ。

function steps(page: Page) {
  const consult = page.getByTestId("consult");
  const progress = page.getByTestId("consult-progress");
  const choose = (name: string) => consult.getByRole("button", { name, exact: true }).click();
  const calendar = page.getByTestId("consult-calendar");
  return {
    consult,
    progress,
    choose,
    calendar,
    back: () => page.getByTestId("consult-back").click(),
    forward: () => page.getByTestId("consult-forward").click(),
    decide: () => consult.getByTestId("consult-decide").click(),
    /** 来月の n 番目（0 から）の選べる日 */
    day: (n: number) => calendar.locator("button[data-date]:not([disabled])").nth(n),
    nextMonth: () => calendar.getByRole("button").nth(1).click(),
    station: async () => {
      const box = consult.getByRole("textbox", { name: "最寄りの駅" });
      await box.fill("みなと中央駅");
      await box.press("Enter");
    },
    travel: page.getByTestId("consult-travel"),
  };
}

async function start(page: Page) {
  await enterShop(page);
  await chooseTripEntry(page);
  const s = steps(page);
  await s.choose("ひとりで");
  await expect(s.progress).toHaveText("2 / 10");
  return s;
}

test.beforeEach(({ page: _page }, info) => {
  test.skip(info.project.name !== "desktop", "デスクトップだけで確かめる");
});

test("はじめから日帰りを選ぶと、片道の所要時間を選べる", async ({ page }) => {
  const s = await start(page);
  await s.choose("今週末");
  await s.choose("日帰り");
  await s.station();
  await expect(s.progress).toHaveText("4 / 10");
  await expect(s.travel).toBeInViewport();
  await expect(s.travel.getByRole("button", { name: "1時間以内", exact: true })).toBeVisible();
});

test("カレンダーで同じ日を2回押して日帰りにすると、片道の所要時間を選べる", async ({ page }) => {
  const s = await start(page);
  await s.choose("日付を指定");
  await s.nextMonth();
  await s.day(0).click();
  await s.day(0).click();
  await expect(page.getByTestId("consult-nights")).toContainText("日帰り");
  await s.decide();
  await s.station();
  await expect(s.travel).toBeInViewport();
});

test("1泊を選んだあと ＜ で戻って日帰りに直すと、片道の所要時間を選べる", async ({ page }) => {
  const s = await start(page);
  await s.choose("今週末");
  await s.choose("1泊");
  await s.station();
  await expect(s.progress).toHaveText("4 / 10");
  await expect(s.travel).toHaveCount(0);
  await s.back();
  await s.back();
  await expect(s.progress).toHaveText("2 / 10");
  await s.choose("日帰り");
  await expect(s.progress).toHaveText("3 / 10");
  await s.forward();
  await expect(s.progress).toHaveText("4 / 10");
  await expect(s.travel).toBeInViewport();
});

test("カレンダーで1泊にしたあと戻って、同じ日を2回押して日帰りに直すと、選べる", async ({
  page,
}) => {
  const s = await start(page);
  await s.choose("日付を指定");
  await s.nextMonth();
  await s.day(0).click();
  await s.day(1).click();
  await expect(page.getByTestId("consult-nights")).toContainText("1泊2日");
  await s.decide();
  await s.station();
  await expect(s.travel).toHaveCount(0);
  await s.back();
  await s.back();
  await s.day(0).click();
  await s.day(0).click();
  await expect(page.getByTestId("consult-nights")).toContainText("日帰り");
  await s.decide();
  await s.forward();
  await expect(s.travel).toBeInViewport();
});

test("カレンダーで1泊にしたあと戻って、1日だけ押して ＞ で進むと、日帰りとして選べる", async ({
  page,
}) => {
  const s = await start(page);
  await s.choose("日付を指定");
  await s.nextMonth();
  await s.day(0).click();
  await s.day(1).click();
  await s.decide();
  await s.station();
  await s.back();
  await s.back();
  await s.day(0).click();
  await s.forward();
  await s.forward();
  await expect(s.progress).toHaveText("4 / 10");
  await expect(s.travel).toBeInViewport();
});

test("確認から日程を直して日帰りにすると、行き先へ進んで片道の所要時間を選べる", async ({
  page,
}) => {
  const s = await start(page);
  await s.choose("今週末");
  await s.choose("1泊");
  await s.station();
  await s.choose("関東");
  await s.decide();
  for (const name of ["温泉", "海鮮"]) {
    await s.choose(name);
    await s.decide();
  }
  await s.choose("ゆっくり");
  await s.choose("〜3万円");
  await s.decide();
  await expect(s.progress).toHaveText("10 / 10");
  await s.consult.getByRole("button", { name: /日程.*直す|直す.*日程/ }).click();
  await expect(s.progress).toHaveText("2 / 10");
  await s.choose("日帰り");
  await expect(s.progress).toHaveText("4 / 10");
  await expect(s.travel).toBeInViewport();
});
