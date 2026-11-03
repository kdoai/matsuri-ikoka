import type { Itinerary } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { buildItinerary, diffDays, type ItineraryDraft } from "./itinerary";
import { lookup, testFestival } from "./testFestivals";

const festival = testFestival({ id: "suzunari-toro" });
const find = lookup(festival);

function draftOf(itinerary: Itinerary): ItineraryDraft {
  const { id: _id, version: _v, verification: _ver, days, ...rest } = itinerary;
  return {
    ...rest,
    days: days.map(({ weather: _w, items, ...day }) => ({
      ...day,
      items: items.map(({ changedInVersion: _c, ...item }) => item),
    })),
  };
}

/** 1日目の予定（日帰りの旅程の予定） */
const itemsOf = (draft: ItineraryDraft) => draft.days[0]!.items;

/** 祭りの日の前日に、泊まりの1日を足した2日の下書き */
function twoDays(): ItineraryDraft {
  const draft = draftOf(fictionalItinerary());
  const festivalDay = draft.days[0]!;
  return {
    ...draft,
    days: [
      {
        date: "2026-08-15",
        stay: { area: "鈴鳴の町" },
        items: [{ ...itemsOf(draft)[1]!, id: "d1-hall" }],
      },
      { ...festivalDay, items: festivalDay.items.filter((item) => item.id !== "craft-hall") },
    ],
  };
}

const build = (draft: ItineraryDraft, previous: Itinerary | null = null) =>
  buildItinerary(draft, {
    id: "trip-1",
    previous,
    weatherFor: () => ({ status: "not_yet" }),
    findFestival: find,
  });

describe("diffDays", () => {
  it("初版はすべて追加で、fromVersion は 0", () => {
    const draft = draftOf(fictionalItinerary());

    const { diff, days } = diffDays(null, draft.days, 1);

    expect(diff).toEqual({
      fromVersion: 0,
      toVersion: 1,
      added: ["go", "craft-hall", "festival"],
      changed: [],
      removed: [],
    });
    expect(days[0]!.items.every((item) => item.changedInVersion === 1)).toBe(true);
  });

  it("追加・変更・削除を予定の id で分け、変わらない予定は前の版のままにする", () => {
    const previous = fictionalItinerary();
    const draft = draftOf(previous);
    const items = itemsOf(draft);
    draft.days[0]!.items = [
      { ...items[0]!, end: "15:25" },
      items[2]!,
      { ...items[1]!, id: "tea", name: "茶屋" },
    ];

    const { diff, days } = diffDays(previous, draft.days, 2);

    expect(diff).toEqual({
      fromVersion: 1,
      toVersion: 2,
      added: ["tea"],
      changed: ["go"],
      removed: [{ id: "craft-hall", name: "鈴鳴和紙の館" }],
    });
    expect(days[0]!.items.map((item) => [item.id, item.changedInVersion])).toEqual([
      ["go", 2],
      ["festival", 1],
      ["tea", 2],
    ]);
  });

  it("中身が同じでも、別の日へ移った予定は変わった予定にする", () => {
    const first = build(twoDays());
    if (!first.ok) throw new Error("初版が作れない");
    const draft = draftOf(first.itinerary);
    const moved = draft.days[0]!.items[0]!;
    draft.days[0]!.items = [{ ...moved, id: "d1-walk" }];
    draft.days[1]!.items = [...draft.days[1]!.items, moved];

    const { diff } = diffDays(first.itinerary, draft.days, 2);

    expect(diff.changed).toEqual(["d1-hall"]);
    expect(diff.added).toEqual(["d1-walk"]);
  });
});

describe("buildItinerary", () => {
  it("初版を作り、版 1・確認前・日ごとの天気を付ける", () => {
    const result = build(draftOf(fictionalItinerary()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.itinerary).toMatchObject({
      id: "trip-1",
      version: 1,
      verification: { status: "pending" },
    });
    expect(result.itinerary.days[0]?.weather).toEqual({ status: "not_yet" });
    expect(result.diff.fromVersion).toBe(0);
  });

  it("泊まりの旅は、日ごとに天気を引いて付ける", () => {
    const asked: string[] = [];
    const result = buildItinerary(twoDays(), {
      id: "trip-1",
      previous: null,
      weatherFor: (date) => {
        asked.push(date);
        return { status: "not_yet" };
      },
      findFestival: find,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(asked).toEqual(["2026-08-15", "2026-08-16"]);
    expect(result.itinerary.days.map((day) => day.stay)).toEqual([{ area: "鈴鳴の町" }, null]);
  });

  it("場所・営業時間・出典は、モデルの書いた値ではなく祭りのデータで入れ直す", () => {
    const draft = draftOf(fictionalItinerary());
    const hall = itemsOf(draft)[1]!;
    itemsOf(draft)[1] = {
      ...hall,
      location: { lat: 0, lng: 0 },
      hours: { open: "06:00", close: "23:00" },
      sources: [
        { url: "https://example.org/made-up", checkedAt: "2026-04-01", confidence: "official" },
      ],
    };

    const result = build(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const spot = festival.nearby.find((s) => s.id === "suzunari-craft-hall")!;
    expect(result.itinerary.days[0]?.items[1]).toMatchObject({
      location: spot.location,
      hours: spot.hours,
      sources: spot.sources,
    });
  });

  it("祭りのデータにない URL の出典は外し、そのことを知らせる", () => {
    const draft = draftOf(fictionalItinerary());
    itemsOf(draft)[0] = {
      ...itemsOf(draft)[0]!,
      sources: [
        { url: "https://example.org/made-up", checkedAt: "2026-04-01", confidence: "official" },
        festival.access.sources[0]!,
      ],
    };

    const result = build(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.itinerary.days[0]?.items[0]?.sources).toEqual(festival.access.sources);
    expect(result.warnings.map((w) => [w.code, w.itemId])).toContainEqual(["unknown_source", "go"]);
  });

  it("旅程の検証で誤りがあれば保存しない", () => {
    const draft = draftOf(fictionalItinerary());
    itemsOf(draft)[1] = { ...itemsOf(draft)[1]!, start: "09:00", end: "09:50" };
    itemsOf(draft)[0] = { ...itemsOf(draft)[0]!, start: "08:00", end: "08:50" };

    const result = build(draft);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toEqual(["outside_hours"]);
  });

  it("スキーマに合わなければ保存しない（主役の祭りの予定がない）", () => {
    const draft = draftOf(fictionalItinerary());
    draft.days[0]!.items = itemsOf(draft).filter((item) => item.type !== "festival");

    const result = build(draft);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("invalid");
  });

  it("修正では版を上げ、主役の祭りと日付が同じなら再確認の結果を引き継ぐ", () => {
    const first = build(draftOf(fictionalItinerary()));
    if (!first.ok) throw new Error("初版が作れない");
    const verified: Itinerary = {
      ...first.itinerary,
      verification: {
        status: "as_planned",
        checkedAt: "2026-08-03T10:00:00+09:00",
        sources: festival.occurrences[0]!.sources,
      },
    };
    const draft = draftOf(verified);
    itemsOf(draft)[1] = { ...itemsOf(draft)[1]!, end: "16:10" };

    const second = build(draft, verified);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.unchanged).toBe(false);
    expect(second.itinerary.version).toBe(2);
    expect(second.itinerary.verification.status).toBe("as_planned");
    expect(second.diff).toMatchObject({ fromVersion: 1, toVersion: 2, changed: ["craft-hall"] });
  });

  it("日を足しても主役の祭りの日が同じなら、再確認の結果を引き継ぐ", () => {
    const first = build(draftOf(fictionalItinerary()));
    if (!first.ok) throw new Error("初版が作れない");
    const verified: Itinerary = {
      ...first.itinerary,
      verification: {
        status: "as_planned",
        checkedAt: "2026-08-03T10:00:00+09:00",
        sources: festival.occurrences[0]!.sources,
      },
    };

    const second = build(twoDays(), verified);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.itinerary.verification.status).toBe("as_planned");
  });

  it("前の版とまったく同じなら版を上げない", () => {
    const first = build(draftOf(fictionalItinerary()));
    if (!first.ok) throw new Error("初版が作れない");

    const again = build(draftOf(first.itinerary), first.itinerary);

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.unchanged).toBe(true);
    expect(again.itinerary.version).toBe(1);
  });

  it("泊まる地域だけを変えても、前の版と同じとはしない", () => {
    const first = build(twoDays());
    if (!first.ok) throw new Error("初版が作れない");
    const draft = draftOf(first.itinerary);
    draft.days[0]!.stay = { area: "となり町" };

    const second = build(draft, first.itinerary);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.unchanged).toBe(false);
    expect(second.itinerary.version).toBe(2);
  });
});
