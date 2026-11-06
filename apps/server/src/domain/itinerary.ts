import {
  type ConsideredPlace,
  type Festival,
  type IsoDate,
  type Itinerary,
  type ItineraryDay,
  type ItineraryDiff,
  type ItineraryItem,
  ItinerarySchema,
  type LastReturn,
  MAX_TRIP_DAYS,
  type MealPlan,
  mainFestivalDay,
  type NearbySpot,
  type PlanGap,
  type Source,
  type Stay,
  type TripBudget,
  type Weather,
} from "@matsuri-ikoka/schema";
import { addDays } from "./calendar";
import { mealCandidates } from "./nearby";
import { checkPlan, occurrenceOn, type PlanIssue } from "./planCheck";
import {
  findGaps,
  MIN_MEAL_MINUTES,
  mealSlotLabel,
  missingMeals,
  type ResearchedPlace,
  reconcileConsidered,
} from "./planCoverage";

// 旅程係が書いた下書きから、保存する旅程を作る。
// 場所・営業時間・出典は祭りのデータから入れ直し、天気を日ごとに付け、版と差分を付け、
// 調べた場所の採否と不足（gaps）を付け、スキーマと旅程の検証を通す。
// 日帰りのお出かけ（1日）から6泊7日まで同じ形で扱う。

export type ItineraryItemDraft = Omit<ItineraryItem, "changedInVersion">;

/** 下書きの1日。天気はサーバーが付ける */
export type ItineraryDayDraft = Omit<ItineraryDay, "weather" | "items"> & {
  items: ItineraryItemDraft[];
};

/**
 * 旅程の下書き。予算・不足・評価はサーバーが付けるので、下書きには持たない。
 * 調べた場所の採否は、理由だけを書く（採ったかと名前はサーバーが決める）
 */
export type ItineraryDraft = Omit<
  Itinerary,
  "id" | "version" | "verification" | "budget" | "days" | "gaps" | "evaluation" | "considered"
> & {
  considered?: Pick<ConsideredPlace, "id" | "reason">[] | undefined;
  days: ItineraryDayDraft[];
};

export interface ItineraryIssue {
  code: PlanIssue["code"] | "invalid" | "unknown_source" | "meal_missing";
  itemId: string | null;
  message: string;
}

export type BuildItineraryResult =
  | {
      ok: true;
      /** 前の版とまったく同じなら true（版を上げない） */
      unchanged: boolean;
      itinerary: Itinerary;
      diff: ItineraryDiff;
      warnings: ItineraryIssue[];
      /** そろっていないもの（itinerary.gaps と同じ） */
      gaps: PlanGap[];
    }
  | { ok: false; errors: ItineraryIssue[]; warnings: ItineraryIssue[] };

/** キーの順に左右されない比較のための文字列 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutVersion(item: ItineraryItem | ItineraryItemDraft): ItineraryItemDraft {
  const { changedInVersion: _, ...rest } = item as ItineraryItem;
  return rest;
}

/**
 * 前の版からの差分と、予定ごとの「最後に変わった版」を付ける。
 * 予定は旅程全体の id で照らし合わせ、別の日へ移った予定は変わった予定にする
 */
export function diffDays(
  previous: Itinerary | null,
  days: readonly ItineraryDayDraft[],
  version: number,
): { days: Omit<ItineraryDay, "weather">[]; diff: ItineraryDiff } {
  const before = new Map<string, { item: ItineraryItem; date: IsoDate }>();
  for (const day of previous?.days ?? []) {
    for (const item of day.items) before.set(item.id, { item, date: day.date });
  }
  const added: string[] = [];
  const changed: string[] = [];
  const next = days.map((day) => ({
    ...day,
    items: day.items.map((item): ItineraryItem => {
      const old = before.get(item.id);
      if (old === undefined) {
        added.push(item.id);
        return { ...item, changedInVersion: version };
      }
      const same =
        old.date === day.date &&
        stableStringify(withoutVersion(old.item)) === stableStringify(withoutVersion(item));
      if (!same) {
        changed.push(item.id);
        return { ...item, changedInVersion: version };
      }
      return { ...item, changedInVersion: old.item.changedInVersion };
    }),
  }));
  const ids = new Set(days.flatMap((day) => day.items.map((item) => item.id)));
  const removed = [...before.values()]
    .filter(({ item }) => !ids.has(item.id))
    .map(({ item }) => ({ id: item.id, name: item.name }));
  return {
    days: next,
    diff: { fromVersion: previous?.version ?? 0, toVersion: version, added, changed, removed },
  };
}

/** 祭りのデータにある出典を、URL で引けるように集める */
export function knownSources(festival: Festival): Map<string, Source> {
  const all: Source[] = [
    ...festival.sources,
    ...festival.occurrences.flatMap((o) => o.sources),
    ...festival.etiquette.sources,
    ...festival.access.sources,
    ...festival.food.local.flatMap((f) => f.sources),
    ...festival.nearby.flatMap((s) => s.sources),
    ...festival.trivia.map((t) => t.source),
  ];
  const byUrl = new Map<string, Source>();
  for (const source of all) {
    if (!byUrl.has(source.url)) byUrl.set(source.url, source);
  }
  return byUrl;
}

/**
 * 予定の場所・営業時間・出典を、祭りのデータで入れ直す。
 * モデルの書いた値より、データにある値を正とする。データにない URL の出典は外す。
 */
export function enrichDraft(
  draft: ItineraryDraft,
  findFestival: (id: string) => Festival | undefined,
  /** 祭りのデータのほかに照らす場所（周辺係が Web で調べた場所）。キーは場所の ID */
  extraSpots: ReadonlyMap<string, NearbySpot> = new Map(),
  /** 祭りのデータのほかに認める出典（行き方の調べで実際に読んだページ）。キーは URL */
  extraSources: ReadonlyMap<string, Source> = new Map(),
): { draft: ItineraryDraft; warnings: ItineraryIssue[] } {
  const warnings: ItineraryIssue[] = [];
  const festivalIds = new Set([
    draft.mainFestivalId,
    ...draft.days.flatMap((day) =>
      day.items.flatMap((item) => (item.festivalId === undefined ? [] : [item.festivalId])),
    ),
  ]);
  const festivals = [...festivalIds].flatMap((id) => {
    const festival = findFestival(id);
    return festival === undefined ? [] : [festival];
  });
  const sources = new Map<string, Source>(extraSources);
  const spots = new Map<string, NearbySpot>(extraSpots);
  for (const festival of festivals) {
    for (const [url, source] of knownSources(festival)) sources.set(url, source);
    for (const spot of festival.nearby) spots.set(spot.id, spot);
  }

  const enrichItem = (item: ItineraryItemDraft, date: IsoDate): ItineraryItemDraft => {
    const spot = item.spotId === undefined ? undefined : spots.get(item.spotId);
    if (spot !== undefined) {
      return { ...item, location: spot.location, hours: spot.hours, sources: spot.sources };
    }
    const festival =
      item.type === "festival" && item.festivalId !== undefined
        ? festivals.find((f) => f.id === item.festivalId)
        : undefined;
    if (festival !== undefined) {
      const occurrence = occurrenceOn(festival, date);
      return {
        ...item,
        location: { lat: festival.venue.lat, lng: festival.venue.lng },
        sources: occurrence?.sources ?? festival.sources,
      };
    }
    const known = item.sources.flatMap((source) => {
      const match = sources.get(source.url);
      return match === undefined ? [] : [match];
    });
    if (known.length < item.sources.length) {
      warnings.push({
        code: "unknown_source",
        itemId: item.id,
        message: `「${item.name}」の出典のうち、祭りのデータにない URL を外しました`,
      });
    }
    return { ...item, sources: known };
  };

  /** 出典を、祭りのデータと調べた結果にある URL だけにする */
  const knownOnly = (list: readonly Source[], label: string): Source[] => {
    const known = list.flatMap((source) => {
      const match = sources.get(source.url);
      return match === undefined ? [] : [match];
    });
    if (known.length < list.length) {
      warnings.push({
        code: "unknown_source",
        itemId: null,
        message: `${label}の出典のうち、祭りのデータにも調べた結果にもない URL を外しました`,
      });
    }
    return known;
  };
  /**
   * 食事の案の出典を入れ直す。店の場所はそのデータの出典、祭りの予定の中の屋台はその祭りの出典にする。
   * 出典の要る案（店・屋台）で出典が残らなければ、案を外す（不足 meal_missing になる）
   */
  const enrichMeal = (meal: MealPlan, items: readonly ItineraryItemDraft[]): MealPlan[] => {
    const spot = meal.spotId === undefined ? undefined : spots.get(meal.spotId);
    const host = items.find((item) => item.id === meal.itemId);
    const mealSources =
      spot !== undefined
        ? spot.sources
        : meal.kind === "stalls" && host?.type === "festival"
          ? host.sources
          : knownOnly(meal.sources, `食事の案「${meal.name}」`);
    if ((meal.kind === "shop" || meal.kind === "stalls") && mealSources.length === 0) return [];
    // 屋台がないと分かっている祭りでは、屋台で食べる案を認めない
    const hostFestival = festivals.find((f) => f.id === host?.festivalId);
    if (meal.kind === "stalls" && hostFestival?.food.stalls === "no") return [];
    return [{ ...meal, sources: mealSources }];
  };
  const enrichLastReturn = (last: LastReturn): LastReturn => {
    const kept = knownOnly(last.sources, "帰りの最終");
    // 出典の残らない最終の時刻は使わない（分からないとして不足に書く）
    return kept.length === 0
      ? { ...last, departBy: null, sources: [] }
      : { ...last, sources: kept };
  };

  const days = draft.days.map((day) => {
    const items = day.items.map((item) => enrichItem(item, day.date));
    return {
      ...day,
      items,
      ...(day.meals === undefined
        ? {}
        : { meals: day.meals.flatMap((meal) => enrichMeal(meal, items)) }),
      ...(day.lastReturn == null ? {} : { lastReturn: enrichLastReturn(day.lastReturn) }),
    };
  });
  return { draft: { ...draft, days }, warnings };
}

/**
 * 下書きから保存する旅程を作る。検証のエラーがあれば保存しない。
 * - 版は前の版の次。前の版とまったく同じなら版を上げない
 * - 主役の祭りと、その祭りの日が変わらなければ、確定前の再確認の結果を引き継ぐ
 * - 天気は日ごとに weatherFor から付ける
 */
export function buildItinerary(
  draft: ItineraryDraft,
  options: {
    id: string;
    previous: Itinerary | null;
    weatherFor: (date: IsoDate) => Weather;
    findFestival: (id: string) => Festival | undefined;
    /** 祭りのデータのほかに照らす場所（周辺係が Web で調べた場所）。キーは場所の ID */
    extraSpots?: ReadonlyMap<string, NearbySpot>;
    /** 旅の予算。聞き取った条件から付ける（下書きには書かせない） */
    budget?: TripBudget | undefined;
    /** 祭りのデータのほかに認める出典（行き方の調べで実際に読んだページ）。キーは URL */
    extraSources?: ReadonlyMap<string, Source>;
    /** 周辺係・宿の係が見つけた場所。採否と理由のない場所は不足にする */
    researched?: readonly ResearchedPlace[];
  },
): BuildItineraryResult {
  const { previous } = options;
  const enriched = enrichDraft(
    draft,
    options.findFestival,
    options.extraSpots,
    options.extraSources,
  );
  const warnings: ItineraryIssue[] = [...enriched.warnings];
  const version = (previous?.version ?? 0) + 1;
  const { days, diff } = diffDays(previous, enriched.draft.days, version);
  const keepVerification =
    previous !== null &&
    previous.mainFestivalId === draft.mainFestivalId &&
    mainFestivalDay(previous).date ===
      mainFestivalDay({ ...draft, days: days as ItineraryDay[] }).date;

  const researched = options.researched ?? [];
  const lodgingOfferIds = new Set(
    enriched.draft.days.flatMap((day) => day.stay?.lodging?.offers.map((offer) => offer.id) ?? []),
  );
  const { considered: written, ...rest } = enriched.draft;
  const considered = reconcileConsidered(written, { days }, researched, lodgingOfferIds);
  const gaps = findGaps({ days, considered }, researched).slice(0, 40);
  const candidate = {
    ...rest,
    id: options.id,
    version,
    verification: keepVerification ? previous.verification : { status: "pending" as const },
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    days: days.map((day) => ({ ...day, weather: options.weatherFor(day.date) })),
    ...(considered.length === 0 ? {} : { considered }),
    gaps,
  };
  const parsed = ItinerarySchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "invalid",
        itemId: null,
        message: `${issue.path.join(".") || "旅程"}：${issue.message}`,
      })),
      warnings,
    };
  }

  const check = checkPlan(parsed.data, options.findFestival, options.extraSpots);
  warnings.push(...check.warnings);
  const errors = [
    ...check.errors,
    ...mealIssues(parsed.data, options.findFestival, options.extraSpots),
  ];
  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  if (previous !== null && isSameItinerary(previous, parsed.data, diff)) {
    return { ok: true, unchanged: true, itinerary: previous, diff, warnings, gaps };
  }
  return { ok: true, unchanged: false, itinerary: parsed.data, diff, warnings, gaps };
}

/**
 * 食事の抜けた旅程は保存しない。文には、その時間帯に入れられる店の候補を添える。
 * 店がなくても「駅の周りでお昼（店は当日選ぶ）」のように時間は取れるので、いつでも直せる
 */
function mealIssues(
  itinerary: Itinerary,
  findFestival: (id: string) => Festival | undefined,
  extraSpots: ReadonlyMap<string, NearbySpot> = new Map(),
): ItineraryIssue[] {
  const { days } = itinerary;
  const spots = [...extraSpots.values(), ...(findFestival(itinerary.mainFestivalId)?.nearby ?? [])];
  return days.flatMap((day, index) =>
    missingMeals(day, index === 0, index === days.length - 1).map((slot): ItineraryIssue => {
      const candidates = mealCandidates(spots, day.date, slot)
        .map((spot) => `${spot.name}（${spot.id}）`)
        .join("、");
      const label = days.length > 1 ? `${index + 1}日目：` : "";
      return {
        code: "meal_missing",
        itemId: null,
        message:
          `${label}${mealSlotLabel(slot)}が時間割に入っていません。その時間帯に${MIN_MEAL_MINUTES}分以上の type: meal の予定を入れてください。` +
          (candidates === ""
            ? "店の候補がないので、research_trip（only: nearby）で探してください。それでも店がなければ、spotId なしで「駅の周りで昼ごはん（店は当日選ぶ）」のように時間を取ってください"
            : `候補：${candidates}`),
      };
    }),
  );
}

function isSameItinerary(previous: Itinerary, next: Itinerary, diff: ItineraryDiff): boolean {
  if (diff.added.length + diff.changed.length + diff.removed.length > 0) return false;
  const order = (itinerary: Itinerary) =>
    itinerary.days
      .map((day) => `${day.date}:${day.items.map((item) => item.id).join(",")}`)
      .join("\n");
  if (order(previous) !== order(next)) return false;
  // 評価は保存したあとに付けるので、同じかどうかの比べには入れない
  const overview = ({ id: _id, version: _v, evaluation: _e, days, ...rest }: Itinerary) => ({
    ...rest,
    days: days.map(({ items: _items, ...day }) => day),
  });
  return stableStringify(overview(previous)) === stableStringify(overview(next));
}

// ---------------------------------------------------------------------------
// 1日ずつ書く

/** 保存した旅程を、旅程係の下書きの形に戻す */
export function draftFromItinerary(itinerary: Itinerary): ItineraryDraft {
  const {
    id: _id,
    version: _version,
    verification: _verification,
    budget: _budget,
    gaps: _gaps,
    evaluation: _evaluation,
    days,
    ...rest
  } = itinerary;
  return {
    ...rest,
    days: days.map(({ weather: _weather, items, ...day }) => ({
      ...day,
      items: items.map(({ changedInVersion: _changed, ...item }) => item),
    })),
  };
}

export type MergeDayResult = { ok: true; draft: ItineraryDraft } | { ok: false; message: string };

/**
 * 保存した下書きに1日を書き足す。同じ日付の日は置き換え、最後の日の次の日は後ろに、最初の日の前の日は前に足す。
 * 後ろに足すときは、それまでの最後の日の夜に泊まる地域（stayBefore）が要る（最後の日は泊まるところを持たないため）
 */
export function mergeDay(
  draft: ItineraryDraft,
  day: ItineraryDayDraft,
  stayBefore?: Stay,
): MergeDayResult {
  const { days } = draft;
  const first = days[0];
  const last = days.at(-1);
  if (first === undefined || last === undefined)
    return { ok: true, draft: { ...draft, days: [day] } };

  const index = days.findIndex((d) => d.date === day.date);
  if (index >= 0) {
    if (index === days.length - 1 && day.stay !== null) {
      return { ok: false, message: "最後の日は帰る日なので、stay を null にしてください" };
    }
    return { ok: true, draft: { ...draft, days: days.with(index, day) } };
  }
  if (days.length >= MAX_TRIP_DAYS) {
    return { ok: false, message: `旅程は${MAX_TRIP_DAYS}日（6泊）までです` };
  }
  if (day.date === addDays(last.date, 1)) {
    if (stayBefore === undefined) {
      return {
        ok: false,
        message: `後ろに日を足すときは、${last.date} の夜に泊まる地域を stayBefore に書いてください`,
      };
    }
    if (day.stay !== null) {
      return { ok: false, message: "最後の日は帰る日なので、stay を null にしてください" };
    }
    return {
      ok: true,
      draft: { ...draft, days: [...days.slice(0, -1), { ...last, stay: stayBefore }, day] },
    };
  }
  if (day.date === addDays(first.date, -1)) {
    if (day.stay === null) {
      return { ok: false, message: "前に足す日は、その夜に泊まる地域を stay に書いてください" };
    }
    return { ok: true, draft: { ...draft, days: [day, ...days] } };
  }
  return {
    ok: false,
    message: `日付は続けてください（いまの旅程は ${first.date}〜${last.date}）`,
  };
}
