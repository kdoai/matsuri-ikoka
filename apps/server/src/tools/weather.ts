import type { IsoDate, Prefecture, Weather } from "@matsuri-ikoka/schema";
import { z } from "zod";

// 気象庁の予報（JSON。キー不要）から、旅の日の天気を引く。
// 3日先までは府県天気予報、それより先は週間予報を使い、範囲の外は「予報前」と返す。

const FORECAST_URL = "https://www.jma.go.jp/bosai/forecast/data/forecast";
const FORECAST_PAGE = "https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=";
export const WEATHER_CACHE_MS = 30 * 60 * 1000;
export const WEATHER_TIMEOUT_MS = 5000;

/** 都道府県から予報を出す気象台の地域コード。北海道・沖縄・鹿児島は代表の地域を使う */
export const JMA_OFFICE_BY_PREFECTURE: Readonly<Record<Prefecture, string>> = {
  北海道: "016000",
  青森県: "020000",
  岩手県: "030000",
  宮城県: "040000",
  秋田県: "050000",
  山形県: "060000",
  福島県: "070000",
  茨城県: "080000",
  栃木県: "090000",
  群馬県: "100000",
  埼玉県: "110000",
  千葉県: "120000",
  東京都: "130000",
  神奈川県: "140000",
  新潟県: "150000",
  富山県: "160000",
  石川県: "170000",
  福井県: "180000",
  山梨県: "190000",
  長野県: "200000",
  岐阜県: "210000",
  静岡県: "220000",
  愛知県: "230000",
  三重県: "240000",
  滋賀県: "250000",
  京都府: "260000",
  大阪府: "270000",
  兵庫県: "280000",
  奈良県: "290000",
  和歌山県: "300000",
  鳥取県: "310000",
  島根県: "320000",
  岡山県: "330000",
  広島県: "340000",
  山口県: "350000",
  徳島県: "360000",
  香川県: "370000",
  愛媛県: "380000",
  高知県: "390000",
  福岡県: "400000",
  佐賀県: "410000",
  長崎県: "420000",
  熊本県: "430000",
  大分県: "440000",
  宮崎県: "450000",
  鹿児島県: "460100",
  沖縄県: "471000",
};

// 外から来る JSON なので、使う部分だけを検証する
const AreaSchema = z.object({ name: z.string(), code: z.string() });
const TimeSeriesSchema = z.object({
  timeDefines: z.array(z.string()),
  areas: z.array(
    z
      .object({
        area: AreaSchema,
        weathers: z.array(z.string()).optional(),
        weatherCodes: z.array(z.string()).optional(),
        pops: z.array(z.string()).optional(),
        tempsMin: z.array(z.string()).optional(),
        tempsMax: z.array(z.string()).optional(),
      })
      .loose(),
  ),
});
const ForecastSchema = z.array(z.object({ timeSeries: z.array(TimeSeriesSchema) }).loose()).min(1);
type Forecast = z.infer<typeof ForecastSchema>;

export interface WeatherReport {
  weather: Weather;
  /** 予報の地域（例：南部）。予報がなければ null */
  area: string | null;
}

const dateOf = (time: string) => time.slice(0, 10);

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 週間予報の天気コードの大まかな分類。細かい表現は府県天気予報の文章に任せる */
function weeklySummary(code: string | undefined): string | null {
  switch (code?.[0]) {
    case "1":
      return "晴れが中心（週間予報）";
    case "2":
      return "くもりが中心（週間予報）";
    case "3":
      return "雨が中心（週間予報）";
    case "4":
      return "雪が中心（週間予報）";
    default:
      return null;
  }
}

/** 予報の JSON から、その日の天気を取り出す */
export function readForecast(
  json: unknown,
  options: { date: IsoDate; today: IsoDate; officeCode: string; checkedAt: IsoDate },
): WeatherReport {
  const parsed = ForecastSchema.safeParse(json);
  if (!parsed.success) return { weather: { status: "unavailable" }, area: null };
  const forecast: Forecast = parsed.data;
  const { date } = options;
  const source = {
    url: `${FORECAST_PAGE}${options.officeCode}`,
    title: "気象庁 天気予報",
    checkedAt: options.checkedAt,
    confidence: "official" as const,
  };

  const short = forecast[0]?.timeSeries;
  const weekly = forecast[1]?.timeSeries;
  const weeklyTemps = weekly?.[1];
  const tempIndex = weeklyTemps?.timeDefines.findIndex((t) => dateOf(t) === date) ?? -1;
  const tempArea = weeklyTemps?.areas[0];
  const highC = tempIndex < 0 ? null : toNumber(tempArea?.tempsMax?.[tempIndex]);
  const lowC = tempIndex < 0 ? null : toNumber(tempArea?.tempsMin?.[tempIndex]);

  const shortWeathers = short?.[0];
  const shortIndex = shortWeathers?.timeDefines.findIndex((t) => dateOf(t) === date) ?? -1;
  const shortArea = shortWeathers?.areas[0];
  const shortText = shortIndex < 0 ? undefined : shortArea?.weathers?.[shortIndex];
  if (shortText !== undefined && shortArea !== undefined) {
    const popsSeries = short?.[1];
    const pops = (popsSeries?.timeDefines ?? []).flatMap((t, i) =>
      dateOf(t) === date ? [toNumber(popsSeries?.areas[0]?.pops?.[i])] : [],
    );
    const known = pops.filter((p): p is number => p !== null);
    return {
      weather: {
        status: "forecast",
        summary: shortText.replace(/[\s　]+/g, " ").trim(),
        precipitationPercent: known.length === 0 ? null : Math.max(...known),
        highC,
        lowC,
        source,
      },
      area: shortArea.area.name,
    };
  }

  const weeklyCodes = weekly?.[0];
  const weeklyIndex = weeklyCodes?.timeDefines.findIndex((t) => dateOf(t) === date) ?? -1;
  const weeklyArea = weeklyCodes?.areas[0];
  const summary = weeklyIndex < 0 ? null : weeklySummary(weeklyArea?.weatherCodes?.[weeklyIndex]);
  if (summary !== null && weeklyArea !== undefined) {
    return {
      weather: {
        status: "forecast",
        summary,
        precipitationPercent: toNumber(weeklyArea.pops?.[weeklyIndex]),
        highC,
        lowC,
        source,
      },
      area: weeklyArea.area.name,
    };
  }

  // 予報の範囲より先なら「予報前」、それ以外（過去の日など）は取得できなかった扱い
  const lastDate = [...(short?.[0]?.timeDefines ?? []), ...(weeklyCodes?.timeDefines ?? [])]
    .map(dateOf)
    .sort()
    .at(-1);
  if (date > (lastDate ?? options.today)) return { weather: { status: "not_yet" }, area: null };
  return { weather: { status: "unavailable" }, area: null };
}

export interface WeatherService {
  forecast(prefecture: Prefecture, date: IsoDate, today: IsoDate): Promise<WeatherReport>;
}

/** 気象庁の予報を読む。地域ごとに30分キャッシュし、5秒で打ち切る */
export function createJmaWeather(
  options: { fetch?: typeof fetch; now?: () => number; cacheMs?: number; timeoutMs?: number } = {},
): WeatherService {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? WEATHER_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? WEATHER_TIMEOUT_MS;
  const cache = new Map<string, { at: number; json: Promise<unknown> }>();

  const load = (officeCode: string): Promise<unknown> => {
    const hit = cache.get(officeCode);
    if (hit !== undefined && now() - hit.at < cacheMs) return hit.json;
    const json = fetchFn(`${FORECAST_URL}/${officeCode}.json`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    }).then(async (res) => {
      if (!res.ok) {
        // 読まない本文は片付ける（放っておくと、接続が閉じられたときに例外になることがある）
        await res.body?.cancel().catch(() => {});
        throw new Error(`気象庁の予報を取得できません（${res.status}）`);
      }
      return res.json() as Promise<unknown>;
    });
    cache.set(officeCode, { at: now(), json });
    // 失敗はキャッシュしない
    json.catch(() => cache.delete(officeCode));
    return json;
  };

  return {
    async forecast(prefecture, date, today) {
      const officeCode = JMA_OFFICE_BY_PREFECTURE[prefecture];
      try {
        const json = await load(officeCode);
        return readForecast(json, { date, today, officeCode, checkedAt: today });
      } catch {
        return { weather: { status: "unavailable" }, area: null };
      }
    },
  };
}
