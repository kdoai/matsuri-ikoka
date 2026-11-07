import {
  FestivalSchema,
  GUIDE_STALLS,
  type Itinerary,
  ItinerarySchema,
} from "@matsuri-ikoka/schema";
import { fictionalFestival, fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../i18n";
import { stallFacts } from "./stallFacts";

const itinerary: Itinerary = ItinerarySchema.parse(fictionalItinerary());
const festival = FestivalSchema.parse(fictionalFestival());
const t = MESSAGES.ja;

const facts = (stall: (typeof GUIDE_STALLS)[number], withFestival = true) =>
  stallFacts(
    stall,
    { itinerary, festival: withFestival ? festival : null, festivalLoading: false },
    t,
    "ja",
  );

describe("屋台で読める情報", () => {
  it("どの屋台にも、日本語と英語で読める情報がある", () => {
    for (const stall of GUIDE_STALLS) {
      for (const locale of ["ja", "en"] as const) {
        const list = stallFacts(
          stall,
          { itinerary, festival, festivalLoading: false },
          MESSAGES[locale],
          locale,
        );
        expect(list.length, stall).toBeGreaterThan(0);
        expect(list.every((item) => item.lines.length > 0)).toBe(true);
      }
    }
  });

  it("作法の分からない項目は「不明」と書き、推測で埋めない", () => {
    const unknown = FestivalSchema.parse({
      ...fictionalFestival(),
      etiquette: {
        participation: "unknown",
        howToJoin: "unknown",
        rules: "unknown",
        dress: "unknown",
        bring: "unknown",
        risk: "unknown",
        photo: "unknown",
        sources: [],
      },
    });
    const list = stallFacts(
      "etiquette",
      { itinerary: { ...itinerary, notes: [] }, festival: unknown, festivalLoading: false },
      t,
      "ja",
    );
    expect(list.flatMap((item) => item.lines).every((line) => line === t.etiquette.unknown)).toBe(
      true,
    );
  });

  it("祭りのデータがまだなくても、旅程から読めるものを出す", () => {
    expect(facts("access", false).length).toBeGreaterThan(0);
    const etiquette = facts("etiquette", false);
    expect(etiquette[0]?.lines).toEqual([t.street.facts.none]);
  });

  it("屋台があるか分からない祭りは「不明」と書き、項目を消さない", () => {
    const unknown = FestivalSchema.parse({
      ...fictionalFestival(),
      food: { stalls: "unknown", local: [] },
    });
    const list = stallFacts(
      "food",
      { itinerary, festival: unknown, festivalLoading: false },
      t,
      "ja",
    );
    expect(list.find((item) => item.label === t.street.facts.foodStallsLabel)?.lines).toEqual([
      t.etiquette.unknown,
    ]);
  });

  it("英語の画面に、全角の区切りを出さない", () => {
    const en = MESSAGES.en;
    for (const stall of GUIDE_STALLS) {
      const list = stallFacts(
        stall,
        { itinerary, festival: null, festivalLoading: false },
        en,
        "en",
      );
      // 旅程の中の文（名前や予定の説明）を除いた、画面が付ける見出しの区切りを見る
      for (const item of list) expect(item.label, stall).not.toMatch(/[（）：]/);
    }
    expect(en.street.labelled("A", "B")).toBe("A: B");
    expect(en.street.dated("A", "B")).toBe("A (B)");
    expect(en.street.joined(["A", "B"])).toBe("A, B");
    expect(en.street.dotted(["A", "B"])).toBe("A · B");
  });

  it("英語の見出しは、文中の形（the …）にしない", () => {
    for (const stall of GUIDE_STALLS) {
      expect(MESSAGES.en.street.stalls[stall].title, stall).not.toMatch(/^the /);
    }
  });

  it("作法には出典を添える", () => {
    expect(facts("etiquette")[0]?.sources.length).toBeGreaterThan(0);
  });

  it("泊まりのない旅は、泊まりがないと書く", () => {
    const dayTrip = {
      ...itinerary,
      days: itinerary.days.map((day) => ({ ...day, stay: null })),
    };
    const list = stallFacts(
      "lodging",
      { itinerary: dayTrip, festival, festivalLoading: false },
      t,
      "ja",
    );
    expect(list[0]?.lines).toEqual([t.street.facts.noStay]);
  });

  it("旅程がなければ、分かっていないと書く", () => {
    const list = stallFacts(
      "food",
      { itinerary: null, festival: null, festivalLoading: false },
      t,
      "ja",
    );
    expect(list[0]?.lines).toEqual([t.street.facts.none]);
  });
});
