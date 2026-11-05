import {
  type FestivalSearchRequest,
  FestivalSearchRequestSchema,
  type FestivalSearchResponse,
  type FestivalWishIntent,
  FestivalWishIntentSchema,
  type IsoDate,
} from "@matsuri-ikoka/schema";
import type { Context, Hono } from "hono";
import type { FestivalStore } from "../data/festivalStore";
import { todayInJapan } from "../domain/calendar";
import { searchFestivalsByConditions } from "../domain/festivalSearch";
import type { StoragePersistence } from "../session/persistence";
import type { SessionStore } from "../session/sessionStore";
import { apiError } from "./errors";
import type { ConcurrencyLimiter, DailyLimiter } from "./guard";

// 祭りから探す API（docs/spec/festival-search.md）。検索はコードだけで行う。
// モデルで自由記述を読むときだけ、相談の回数と、同時に呼ぶ枠を使う。
// 回数の上限や混雑、失敗や時間切れのときは、断らずに言葉の辞書で読んで探す。

/** 自由記述をモデルで読む口。読めなければ null を返すか、例外を投げる */
export type FestivalWishReader = (
  wish: string,
  signal?: AbortSignal,
) => Promise<FestivalWishIntent | null>;

export interface FestivalSearchOptions {
  /** 自由記述をモデルで読む口。省略すると言葉の辞書で読む */
  readFestivalWish?: FestivalWishReader;
  /** モデルの読み取りを待つ上限（ミリ秒） */
  festivalWishTimeoutMs?: number;
  /** 今日の日付。省略すると日本の今日 */
  today?: () => IsoDate;
}

export interface FestivalSearchDeps extends FestivalSearchOptions {
  festivals: FestivalStore;
  sessions: SessionStore;
  persistence?: StoragePersistence;
  limiter: DailyLimiter;
  ipLimiter?: DailyLimiter;
  concurrency?: ConcurrencyLimiter;
  clientIp?: (c: Context) => string;
}

const DEFAULT_WISH_TIMEOUT_MS = 8000;
/** とっておく読み取りの数の上限 */
const MAX_CACHED_READINGS = 500;

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  });
  return Promise.race([run(controller.signal), expired]).finally(() => clearTimeout(timer));
}

export function registerFestivalSearchRoutes(app: Hono, deps: FestivalSearchDeps) {
  const today = deps.today ?? (() => todayInJapan());
  // 同じ相談の同じ自由記述は読み直さない。「別の祭りを提案してもらう」で順がずれず、回数も増えない。
  // 読めなかったとき（null）も残し、途中から言葉の辞書の順に変わらないようにする
  const readings = new Map<string, FestivalWishIntent | null>();

  async function readByModel(c: Context, wish: string): Promise<FestivalWishIntent | null> {
    const reader = deps.readFestivalWish;
    if (reader === undefined) return null;
    const ip = deps.clientIp?.(c) ?? "unknown";
    if (!deps.limiter.allows() || (deps.ipLimiter !== undefined && !deps.ipLimiter.allows(ip))) {
      return null;
    }
    const release = deps.concurrency === undefined ? () => {} : deps.concurrency.tryAcquire();
    if (release === null) return null;
    deps.limiter.consume();
    deps.ipLimiter?.consume(ip);
    try {
      const read = await withTimeout(
        (signal) => reader(wish, signal),
        deps.festivalWishTimeoutMs ?? DEFAULT_WISH_TIMEOUT_MS,
      );
      // モデルの返事は信用しない入力として、形を確かめてから使う
      const parsed = FestivalWishIntentSchema.safeParse(read);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      console.warn("[festival-search] 自由記述を読めませんでした", (error as Error).message);
      return null;
    } finally {
      release();
    }
  }

  async function wishIntent(
    c: Context,
    request: FestivalSearchRequest,
  ): Promise<FestivalWishIntent | undefined> {
    const wish = request.wish;
    if (deps.readFestivalWish === undefined || wish === undefined || wish === "") return undefined;
    const key = `${request.sessionId}\u0000${wish}`;
    let read = readings.get(key);
    if (read === undefined) {
      read = await readByModel(c, wish);
      if (readings.size >= MAX_CACHED_READINGS) {
        readings.delete(readings.keys().next().value as string);
      }
      readings.set(key, read);
    }
    return read ?? undefined;
  }

  app.post("/api/festivals/search", async (c) => {
    let request: FestivalSearchRequest;
    try {
      request = FestivalSearchRequestSchema.parse(await c.req.json());
    } catch {
      return c.json(apiError("bad_request", "送った内容の形が正しくありません。", false), 400);
    }
    // 別のインスタンスで始めた相談なら、保存の口から戻す
    await deps.persistence?.load(request.sessionId);
    if (deps.sessions.get(request.sessionId) === undefined) {
      return c.json(
        apiError("bad_request", "相談が見つかりません。新しく始めてください。", false),
        404,
      );
    }
    const response = searchFestivalsByConditions(deps.festivals.list(), {
      conditions: {
        kinds: request.kinds,
        season: request.season,
        prefectures: request.prefectures,
      },
      sessionId: request.sessionId,
      excludeIds: request.excludeIds,
      wish: request.wish,
      wishIntent: await wishIntent(c, request),
      today: today(),
    });
    return c.json(response satisfies FestivalSearchResponse);
  });
}
