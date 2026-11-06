import { FestivalSearchResponseSchema, type FestivalWishIntent } from "@matsuri-ikoka/schema";
import { describe, expect, it, vi } from "vitest";
import { type AppDeps, createApp } from "../app";
import { createFestivalStore } from "../data/festivalStore";
import { testFestival } from "../domain/testFestivals";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { ConcurrencyLimiter, DailyLimiter } from "./guard";

const today = () => "2026-07-01";

const INTENT: FestivalWishIntent = {
  summary: "夜の祭り",
  categories: [],
  terms: ["夜"],
  avoidTerms: [],
  months: [],
  prefectures: [],
  wantsToJoin: false,
};

function setup(overrides: Partial<AppDeps> = {}) {
  const itineraries = new ItineraryStore();
  const sessions = new SessionStore();
  const festivals = createFestivalStore([
    testFestival({ id: "open", date: "2026-08-01" }),
    testFestival({ id: "stopped", date: "2026-08-01", optOut: true }),
    testFestival({ id: "over", date: "2026-08-01", status: "cancelled" }),
  ]);
  const deps: AppDeps = {
    runner: { mode: "mock", runTurn: async () => {} },
    sessions,
    itineraries,
    festivals,
    limiter: new DailyLimiter(null, today),
    accessPasscode: null,
    today,
    ...overrides,
  };
  const app = createApp(deps);
  const search = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/festivals/search", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const session = sessions.create({ replay: null });
  const request = { sessionId: session.id, kinds: [], season: null, prefectures: [] };
  return { search, request, sessions };
}

describe("POST /api/festivals/search", () => {
  it("条件に合う祭りをスキーマの形で返す（中止・掲載停止は出ない）", async () => {
    const { search, request } = setup();
    const res = await search(request);
    expect(res.status).toBe(200);
    const body = FestivalSearchResponseSchema.parse(await res.json());
    expect(body.results.map((r) => r.candidate.festivalId)).toEqual(["open"]);
    expect(body.reading).toBeNull();
  });

  it("形の正しくない本文は 400 で断る", async () => {
    const { search, request } = setup();
    expect((await search("{")).status).toBe(400);
    expect((await search({ ...request, season: "rainy" })).status).toBe(400);
    expect((await search({ ...request, prefectures: ["架空県"] })).status).toBe(400);
    expect((await search({ ...request, wish: "あ".repeat(201) })).status).toBe(400);
    expect((await search({ ...request, extra: 1 })).status).toBe(400);
  });

  it("相談が見つからなければ 404 で断る", async () => {
    const { search, request } = setup();
    expect((await search({ ...request, sessionId: "nobody" })).status).toBe(404);
  });

  it("合言葉を設定していれば、ヘッダーがないと 401 で断る", async () => {
    const { search, request } = setup({ accessPasscode: "pass" });
    expect((await search(request)).status).toBe(401);
    expect((await search(request, { "x-access-passcode": "pass" })).status).toBe(200);
  });

  it("モデルを呼ばない検索は、相談の回数を使わず、上限に達していても探せる", async () => {
    const limiter = new DailyLimiter(0, today);
    const { search, request } = setup({ limiter });
    const res = await search({ ...request, wish: "夜がいい" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reading: { by: string } }).reading.by).toBe("words");
    const counted = new DailyLimiter(1, today);
    const second = setup({ limiter: counted });
    await second.search(second.request);
    await second.search({ ...second.request, wish: "夜がいい" });
    expect(counted.allows()).toBe(true);
  });
});

describe("自由記述をモデルで読む口", () => {
  it("読み取りの結果で探し、回数を1回使う", async () => {
    const limiter = new DailyLimiter(5, today);
    const clientLimiter = new DailyLimiter(1, today);
    const readFestivalWish = vi.fn(async () => INTENT);
    const { search, request } = setup({ limiter, clientLimiter, readFestivalWish });
    const res = await search({ ...request, wish: "夕涼み" });
    const body = (await res.json()) as { reading: unknown };
    expect(body.reading).toEqual({ text: "夜の祭り", by: "model" });
    expect(readFestivalWish).toHaveBeenCalledTimes(1);
    expect(clientLimiter.allows("unknown")).toBe(false);
  });

  it("同じ相談の同じ自由記述は読み直さず、「別の祭り」で順がずれない", async () => {
    const limiter = new DailyLimiter(1, today);
    const readFestivalWish = vi.fn(async () => INTENT);
    const { search, request } = setup({ limiter, readFestivalWish });
    await search({ ...request, wish: "夕涼み" });
    const again = await search({ ...request, wish: "夕涼み", excludeIds: ["open"] });
    expect(readFestivalWish).toHaveBeenCalledTimes(1);
    expect(((await again.json()) as { reading: { by: string } }).reading.by).toBe("model");
  });

  it("書かれていなければモデルを呼ばない", async () => {
    const readFestivalWish = vi.fn(async () => INTENT);
    const { search, request } = setup({ readFestivalWish });
    await search(request);
    await search({ ...request, wish: "   " });
    expect(readFestivalWish).not.toHaveBeenCalled();
  });

  async function readingBy(overrides: Partial<AppDeps>) {
    const { search, request } = setup(overrides);
    const res = await search({ ...request, wish: "夜がいい" });
    expect(res.status).toBe(200);
    return ((await res.json()) as { reading: { by: string } }).reading.by;
  }

  it("失敗・時間切れ・形の違う返事のときは、言葉の辞書で読む", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await readingBy({
        readFestivalWish: async () => {
          throw new Error("失敗");
        },
      }),
    ).toBe("words");
    expect(await readingBy({ readFestivalWish: async () => null })).toBe("words");
    expect(
      await readingBy({
        readFestivalWish: () => new Promise(() => {}),
        festivalWishTimeoutMs: 5,
      }),
    ).toBe("words");
    expect(
      await readingBy({
        readFestivalWish: async () => ({ ...INTENT, terms: [""] }),
      }),
    ).toBe("words");
    vi.restoreAllMocks();
  });

  it("回数の上限や混雑のときは、モデルを呼ばず言葉の辞書で読む", async () => {
    const readFestivalWish = vi.fn(async () => INTENT);
    expect(await readingBy({ readFestivalWish, limiter: new DailyLimiter(0, today) })).toBe(
      "words",
    );
    expect(await readingBy({ readFestivalWish, clientLimiter: new DailyLimiter(0, today) })).toBe(
      "words",
    );
    const concurrency = new ConcurrencyLimiter(1);
    concurrency.tryAcquire();
    expect(await readingBy({ readFestivalWish, concurrency })).toBe("words");
    expect(readFestivalWish).not.toHaveBeenCalled();
  });

  it("読み終えたら同時に呼ぶ枠を返す", async () => {
    const concurrency = new ConcurrencyLimiter(1);
    await readingBy({ readFestivalWish: async () => INTENT, concurrency });
    expect(concurrency.running).toBe(0);
  });
});
