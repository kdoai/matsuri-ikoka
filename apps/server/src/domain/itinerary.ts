import {
  type Festival,
  type Itinerary,
  type ItineraryDiff,
  type ItineraryItem,
  ItinerarySchema,
  type Source,
  type Weather,
} from "@matsuri-ikoka/schema";
import { checkPlan, occurrenceOn, type PlanIssue } from "./planCheck";

// 旅程係が書いた下書きから、保存する旅程を作る。
// 場所・営業時間・出典は祭りのデータから入れ直し、版と差分を付け、スキーマと旅程の検証を通す。

export type ItineraryItemDraft = Omit<ItineraryItem, "changedInVersion">;

export type ItineraryDraft = Omit<
  Itinerary,
  "id" | "version" | "verification" | "weather" | "items"
> & { items: ItineraryItemDraft[] };

export interface ItineraryIssue {
  code: PlanIssue["code"] | "invalid" | "unknown_source";
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

/** 前の版からの差分と、予定ごとの「最後に変わった版」を付ける */
export function diffItems(
  previous: Itinerary | null,
  items: readonly ItineraryItemDraft[],
  version: number,
): { items: ItineraryItem[]; diff: ItineraryDiff } {
  const before = new Map(previous?.items.map((item) => [item.id, item]) ?? []);
  const added: string[] = [];
  const changed: string[] = [];
  const next = items.map((item): ItineraryItem => {
    const old = before.get(item.id);
    if (old === undefined) {
      added.push(item.id);
      return { ...item, changedInVersion: version };
    }
    if (stableStringify(withoutVersion(old)) !== stableStringify(withoutVersion(item))) {
      changed.push(item.id);
      return { ...item, changedInVersion: version };
    }
    return { ...item, changedInVersion: old.changedInVersion };
  });
  const ids = new Set(items.map((item) => item.id));
  const removed = [...before.values()]
    .filter((item) => !ids.has(item.id))
    .map((item) => ({ id: item.id, name: item.name }));
  return {
    items: next,
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
): { draft: ItineraryDraft; warnings: ItineraryIssue[] } {
  const warnings: ItineraryIssue[] = [];
  const festivalIds = new Set([
    draft.mainFestivalId,
    ...draft.items.flatMap((item) => (item.festivalId === undefined ? [] : [item.festivalId])),
  ]);
  const festivals = [...festivalIds].flatMap((id) => {
    const festival = findFestival(id);
    return festival === undefined ? [] : [festival];
  });
  const sources = new Map<string, Source>();
  const spots = new Map<string, Festival["nearby"][number]>();
  for (const festival of festivals) {
    for (const [url, source] of knownSources(festival)) sources.set(url, source);
    for (const spot of festival.nearby) spots.set(spot.id, spot);
  }

  const items = draft.items.map((item): ItineraryItemDraft => {
    const spot = item.spotId === undefined ? undefined : spots.get(item.spotId);
    if (spot !== undefined) {
      return { ...item, location: spot.location, hours: spot.hours, sources: spot.sources };
    }
    const festival =
      item.type === "festival" && item.festivalId !== undefined
        ? festivals.find((f) => f.id === item.festivalId)
        : undefined;
    if (festival !== undefined) {
      const occurrence = occurrenceOn(festival, draft.date);
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
  });

  return { draft: { ...draft, items }, warnings };
}

/**
 * 下書きから保存する旅程を作る。検証のエラーがあれば保存しない。
 * - 版は前の版の次。前の版とまったく同じなら版を上げない
 * - 主役の祭りと日付が変わらなければ、確定前の再確認の結果を引き継ぐ
 */
export function buildItinerary(
  draft: ItineraryDraft,
  options: {
    id: string;
    previous: Itinerary | null;
    weather: Weather;
    findFestival: (id: string) => Festival | undefined;
  },
): BuildItineraryResult {
  const { previous } = options;
  const enriched = enrichDraft(draft, options.findFestival);
  const warnings: ItineraryIssue[] = [...enriched.warnings];
  const version = (previous?.version ?? 0) + 1;
  const { items, diff } = diffItems(previous, enriched.draft.items, version);
  const keepVerification =
    previous !== null &&
    previous.mainFestivalId === draft.mainFestivalId &&
    previous.date === draft.date;

  const candidate = {
    ...enriched.draft,
    id: options.id,
    version,
    verification: keepVerification ? previous.verification : { status: "pending" as const },
    weather: options.weather,
    items,
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

  const check = checkPlan(parsed.data, options.findFestival);
  warnings.push(...check.warnings);
  if (check.errors.length > 0) {
    return { ok: false, errors: check.errors, warnings };
  }

  if (previous !== null && isSameItinerary(previous, parsed.data, diff)) {
    return { ok: true, unchanged: true, itinerary: previous, diff, warnings };
  }
  return { ok: true, unchanged: false, itinerary: parsed.data, diff, warnings };
}

function isSameItinerary(previous: Itinerary, next: Itinerary, diff: ItineraryDiff): boolean {
  if (diff.added.length + diff.changed.length + diff.removed.length > 0) return false;
  const order = (itinerary: Itinerary) => itinerary.items.map((item) => item.id).join("\n");
  if (order(previous) !== order(next)) return false;
  const overview = ({ id: _id, version: _v, items: _items, ...rest }: Itinerary) => rest;
  return stableStringify(overview(previous)) === stableStringify(overview(next));
}
