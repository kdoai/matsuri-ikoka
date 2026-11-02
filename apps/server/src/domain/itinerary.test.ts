import type { Itinerary } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { buildItinerary, diffItems, type ItineraryDraft } from "./itinerary";
import { lookup, testFestival } from "./testFestivals";

const festival = testFestival({ id: "suzunari-toro" });
const find = lookup(festival);

function draftOf(itinerary: Itinerary): ItineraryDraft {
  const { id: _id, version: _v, verification: _ver, weather: _w, items, ...rest } = itinerary;
  return { ...rest, items: items.map(({ changedInVersion: _c, ...item }) => item) };
}

const build = (draft: ItineraryDraft, previous: Itinerary | null = null) =>
  buildItinerary(draft, {
    id: "trip-1",
    previous,
    weather: { status: "not_yet" },
    findFestival: find,
  });

describe("diffItems", () => {
  it("初版はすべて追加で、fromVersion は 0", () => {
    const draft = draftOf(fictionalItinerary());

    const { diff, items } = diffItems(null, draft.items, 1);

    expect(diff).toEqual({
      fromVersion: 0,
      toVersion: 1,
      added: ["go", "craft-hall", "festival"],
      changed: [],
      removed: [],
    });
    expect(items.every((item) => item.changedInVersion === 1)).toBe(true);
  });

  it("追加・変更・削除を予定の id で分け、変わらない予定は前の版のままにする", () => {
    const previous = fictionalItinerary();
    const draft = draftOf(previous);
    draft.items = [
      { ...draft.items[0]!, end: "15:25" },
      draft.items[2]!,
      { ...draft.items[1]!, id: "tea", name: "茶屋" },
    ];

    const { diff, items } = diffItems(previous, draft.items, 2);

    expect(diff).toEqual({
      fromVersion: 1,
      toVersion: 2,
      added: ["tea"],
      changed: ["go"],
      removed: [{ id: "craft-hall", name: "鈴鳴和紙の館" }],
    });
    expect(items.map((item) => [item.id, item.changedInVersion])).toEqual([
      ["go", 2],
      ["festival", 1],
      ["tea", 2],
    ]);
  });
});

describe("buildItinerary", () => {
  it("初版を作り、版 1・確認前・渡した天気を付ける", () => {
    const result = build(draftOf(fictionalItinerary()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.itinerary).toMatchObject({
      id: "trip-1",
      version: 1,
      verification: { status: "pending" },
      weather: { status: "not_yet" },
    });
    expect(result.diff.fromVersion).toBe(0);
  });

  it("場所・営業時間・出典は、モデルの書いた値ではなく祭りのデータで入れ直す", () => {
    const draft = draftOf(fictionalItinerary());
    const hall = draft.items[1]!;
    draft.items[1] = {
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
    expect(result.itinerary.items[1]).toMatchObject({
      location: spot.location,
      hours: spot.hours,
      sources: spot.sources,
    });
  });

  it("祭りのデータにない URL の出典は外し、そのことを知らせる", () => {
    const draft = draftOf(fictionalItinerary());
    draft.items[0] = {
      ...draft.items[0]!,
      sources: [
        { url: "https://example.org/made-up", checkedAt: "2026-04-01", confidence: "official" },
        festival.access.sources[0]!,
      ],
    };

    const result = build(draft);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.itinerary.items[0]?.sources).toEqual(festival.access.sources);
    expect(result.warnings.map((w) => [w.code, w.itemId])).toContainEqual(["unknown_source", "go"]);
  });

  it("旅程の検証で誤りがあれば保存しない", () => {
    const draft = draftOf(fictionalItinerary());
    draft.items[1] = { ...draft.items[1]!, start: "09:00", end: "09:50" };
    draft.items[0] = { ...draft.items[0]!, start: "08:00", end: "08:50" };

    const result = build(draft);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toEqual(["outside_hours"]);
  });

  it("スキーマに合わなければ保存しない（主役の祭りの予定がない）", () => {
    const draft = draftOf(fictionalItinerary());
    draft.items = draft.items.filter((item) => item.type !== "festival");

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
    draft.items[1] = { ...draft.items[1]!, end: "16:10" };

    const second = build(draft, verified);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.unchanged).toBe(false);
    expect(second.itinerary.version).toBe(2);
    expect(second.itinerary.verification.status).toBe("as_planned");
    expect(second.diff).toMatchObject({ fromVersion: 1, toVersion: 2, changed: ["craft-hall"] });
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
});
