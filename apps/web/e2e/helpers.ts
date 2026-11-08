import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SampleConversationSchema } from "@matsuri-ikoka/schema";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

/** 見直し用のスクリーンショットの置き場所（Git の対象外） */
export const SCREENSHOT_DIR =
  process.env.E2E_SCREENSHOT_DIR ?? join(here, "../test-results/screens");

/** 地図のタイルは取りに行かない（E2E_ALLOW_TILES=1 のときだけ取る） */
export async function blockMapTiles(page: Page): Promise<void> {
  if (process.env.E2E_ALLOW_TILES === "1") {
    return;
  }
  await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
}

export async function snap(page: Page, info: TestInfo, name: string, fullPage = false) {
  const dir = join(SCREENSHOT_DIR, info.project.name);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage });
}

/** 接客サーバー（mock）が再生する記録した相談。発言は記録のとおりに送る */
export const SAMPLE = SampleConversationSchema.parse(
  JSON.parse(
    readFileSync(join(here, "../../../data/samples/conversations/suzunari-day-trip.json"), "utf8"),
  ),
);

/**
 * WebGL を使えなくする。3D を描く時間を省いて、相談の流れだけを確かめるときに使う
 * （画面は 2D に切り替えず、3D を描けない知らせを出したまま、会話の窓で相談を進める）
 */
export async function withoutWebgl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
      const [kind] = args as [string];
      if (kind === "webgl" || kind === "webgl2") return null;
      return (original as (...a: unknown[]) => RenderingContext | null).apply(this, args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

/** 店に入り、相談を始められる状態にする。with3d でなければ、3D を描かずに進める */
export async function enterShop(page: Page, { with3d = false } = {}): Promise<void> {
  if (!with3d) await withoutWebgl(page);
  await page.goto("/");
  await page.getByRole("button", { name: "入店する" }).click();
  await talkToConcierge(page);
}

/**
 * 会話の窓は最初は出ていない。コンシェルジュに話しかけて、会話の窓を出す。焦点は選んで進める相談の
 * 最初の選択肢へ移る（3D の店では、入店のカメラが終わってから「話しかける」が出る）
 */
export async function talkToConcierge(
  page: Page,
  name = "コンシェルジュに話しかける",
): Promise<void> {
  // 入店のカメラは1フレームに進む時間に上限があるので、GPU のない環境では1分ほどかかり、その間はボタンが出ない
  await page.getByTestId("greeting-bar").getByRole("button", { name }).click({ timeout: 120_000 });
  await expect(page.getByTestId("dialogue")).toBeVisible();
  await expect(page.getByTestId("consult-choice").first()).toBeFocused();
  await sessionReady(page);
}

/** 相談が始まり、発言を送れるようになるまで待つ */
export async function sessionReady(page: Page): Promise<void> {
  // 聞き取りの間は自分の言葉で書く欄を出さないので、聞き取りの窓の印で待つ
  await expect(
    page
      .locator(
        '[data-testid="composer"][data-ready="true"], [data-testid="consult"][data-ready="true"]',
      )
      .first(),
  ).toBeVisible();
}

/** 聞き取りの選択肢の名前（日本語と英語） */
export const HEARING_WORDS = {
  ja: {
    trip: "旅行計画から探す",
    solo: "ひとりで",
    weekend: "今週末",
    dayTrip: "日帰り",
    station: "最寄りの駅",
    auto: "おまかせ",
    note: "ひとこと",
  },
  en: {
    trip: "Start from a trip plan",
    solo: "Just me",
    weekend: "This weekend",
    dayTrip: "Day trip",
    station: "Nearest station",
    auto: "Up to you",
    note: "Anything else",
  },
};

/** 入口の2択で「旅行計画から探す」を選び、今までの聞き取りへ進む（入口を過ぎていれば何もしない） */
export async function chooseTripEntry(page: Page, words = HEARING_WORDS.ja): Promise<void> {
  const entry = page.getByTestId("consult-entry");
  if (await entry.isVisible()) {
    await entry.getByRole("button", { name: words.trip, exact: true }).click();
  }
}

/**
 * 選んで進める聞き取りに、いちばん短い道で答えて送る。note は最後の「ひとこと」に書く
 * （聞き取りの間は自分の言葉で書く欄を出さないので、最初の発言はここで送る）
 */
export async function answerHearing(
  page: Page,
  note: string,
  words = HEARING_WORDS.ja,
): Promise<void> {
  const consult = page.getByTestId("consult");
  const choose = (name: string) => consult.getByRole("button", { name, exact: true }).click();
  const decide = () => consult.getByTestId("consult-decide").click();
  await chooseTripEntry(page, words);
  await choose(words.solo);
  await choose(words.weekend);
  await choose(words.dayTrip);
  const station = consult.getByRole("textbox", { name: words.station });
  await station.fill("みなと中央駅");
  await station.press("Enter");
  // 行き先・楽しみ・食べたいもの（いくつでも選べる）は決定で、ペース・予算は選ぶとすぐ進む
  for (let i = 0; i < 3; i++) {
    await choose(words.auto);
    await decide();
  }
  await choose(words.auto);
  await choose(words.auto);
  await consult.getByRole("textbox", { name: words.note }).fill(note);
  await decide();
  await consult.getByTestId("consult-submit").click();
}

/** 発言を送る。聞き取りの途中なら、聞き取りに答えて「ひとこと」に書いて送る */
export async function say(page: Page, message: string): Promise<void> {
  await sessionReady(page);
  if (await page.getByTestId("consult").isVisible()) {
    await answerHearing(page, message);
    return;
  }
  const input = page.getByRole("textbox", { name: "相談の発言" });
  await input.fill(message);
  await input.press("Enter");
}

/** 記録の index 番目の発言を入れて送る */
export async function sendSampleMessage(page: Page, index: number): Promise<void> {
  const message = SAMPLE.turns[index]?.request.message;
  if (message === undefined) throw new Error(`記録に ${index} 番目の発言がありません`);
  await say(page, message);
}

/** 返答が終わるまで待つ（送るボタンが「返答を待っています」から戻る） */
export async function waitForReply(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "返答を待っています" })).toHaveCount(0, {
    timeout: 20_000,
  });
}

/** 旅のしおりの窓が閉じていれば、旅程詳細から開く（狭い画面ではメニューから） */
export async function openPanel(page: Page): Promise<void> {
  if (await page.getByTestId("itinerary-panel").isVisible()) {
    return;
  }
  const hint = page.getByTestId("button-hints").getByRole("button", { name: "旅程詳細" });
  if (await hint.isVisible()) {
    await hint.click();
  } else {
    await page.getByRole("button", { name: "メニュー", exact: true }).click();
    await page.getByTestId("game-menu").getByRole("button", { name: "旅程詳細" }).click();
  }
  await expect(page.getByTestId("itinerary-panel")).toBeVisible();
}

/** 2つの部品が画面の上で重なっていないことを確かめる（見えていない部品は数えない） */
export async function expectNoOverlap(
  page: Page,
  testId: string,
  others: readonly string[],
): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box).not.toBeNull();
  for (const other of others) {
    const target = page.getByTestId(other);
    if (box === null || !(await target.isVisible())) continue;
    const rect = await target.boundingBox();
    if (rect === null) continue;
    const overlaps =
      box.x < rect.x + rect.width &&
      rect.x < box.x + box.width &&
      box.y < rect.y + rect.height &&
      rect.y < box.y + box.height;
    expect(overlaps, `${testId} と ${other} が重なっている`).toBe(false);
  }
}

/** 会話の記録を開く（これまでのやりとりと、スタッフ全員のようす） */
export async function openLog(page: Page): Promise<void> {
  // 候補カードが開いていれば、閉じてから
  if (await page.getByTestId("candidates").isVisible()) {
    await page.keyboard.press("Escape");
  }
  await page
    .getByTestId("icon-buttons")
    .getByRole("button", { name: "会話の記録", exact: true })
    .click();
  await expect(page.getByTestId("backlog")).toBeVisible();
}

export async function closeLog(page: Page): Promise<void> {
  await page.getByTestId("backlog").getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByTestId("backlog")).toHaveCount(0);
}

/** Tab だけで、その部品に焦点を移す（キーボードだけで操作できるかを確かめる） */
export async function tabTo(page: Page, target: Locator, limit = 80): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab で焦点を移せませんでした");
}

/**
 * 返答を待つ間だけ出る文（スタッフの吹き出し・豆知識係など）を、出たときに書き留める。
 * 記録の再生が速い・描画が遅い環境でも、出たかどうかをあとから確かめられる。
 * 発言を送る前に呼び、返答のあとで seenTexts で読む。
 */
export async function recordTexts(page: Page, selectors: readonly string[]): Promise<void> {
  await page.evaluate((list) => {
    const seen: Record<string, string[]> = {};
    for (const selector of list) seen[selector] = [];
    const read = () => {
      for (const selector of list) {
        for (const element of document.querySelectorAll(selector)) {
          const text = element.textContent ?? "";
          const bucket = seen[selector];
          if (text !== "" && bucket !== undefined && !bucket.includes(text)) bucket.push(text);
        }
      }
    };
    read();
    new MutationObserver(read).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    (window as unknown as { __seenTexts: Record<string, string[]> }).__seenTexts = seen;
  }, selectors);
}

/** recordTexts で書き留めた文（出た順） */
export async function seenTexts(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(
    (key) =>
      (window as unknown as { __seenTexts?: Record<string, string[]> }).__seenTexts?.[key] ?? [],
    selector,
  );
}

/** 音声認識の代わりが聞き取ったことにする文（架空の祭り） */
export const FAKE_HEARD = "架空の灯籠まつりに行きたい";

/**
 * ブラウザの音声認識の代わり。止めたら、聞き取った文を1つ返して終わる。
 * error を渡すと、始めたときにそのエラー（例：マイクを断られた not-allowed）で終わる。実際の声やマイクは使わない
 */
export async function fakeSpeechRecognition(
  page: Page,
  options: { accepted?: boolean; error?: string } = {},
) {
  await page.addInitScript(
    ({ heard, accepted, error }) => {
      const voice = { made: 0, stopped: 0, aborted: 0 };
      (window as unknown as { __voice: typeof voice }).__voice = voice;
      if (accepted) window.localStorage.setItem("matsuri-ikoka:voice-input-accepted", "1");
      class FakeRecognition {
        lang = "";
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        constructor() {
          voice.made += 1;
        }
        start() {
          if (error === null) return;
          window.setTimeout(() => {
            this.onerror?.({ error });
            this.onend?.();
          }, 20);
        }
        stop() {
          voice.stopped += 1;
          if (error !== null) return;
          window.setTimeout(() => {
            const result = Object.assign([{ transcript: heard }], { isFinal: true });
            this.onresult?.({ results: [result] });
            this.onend?.();
          }, 20);
        }
        abort() {
          voice.aborted += 1;
          window.setTimeout(() => this.onend?.(), 0);
        }
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
    },
    { heard: FAKE_HEARD, accepted: options.accepted ?? false, error: options.error ?? null },
  );
}
