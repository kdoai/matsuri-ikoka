import { describe, expect, it } from "vitest";
import { chooseDesign, daySpanMinutes, pagePlan, seasonOf, tripLengthOf } from "./design";
import { fictionalOuting, fictionalWeek, fictionalWeekend } from "./testTrips";
import type { ShioriTrip } from "./trip";

function count(pages: readonly string[], kind: string): number {
  return pages.filter((p) => p === kind).length;
}

describe("季節", () => {
  it.each([
    ["2026-03-01", "spring"],
    ["2026-05-31", "spring"],
    ["2026-06-01", "summer"],
    ["2026-08-31", "summer"],
    ["2026-09-01", "autumn"],
    ["2026-11-30", "autumn"],
    ["2026-12-01", "winter"],
    ["2027-02-28", "winter"],
  ] as const)("%s は %s", (date, season) => {
    expect(seasonOf(date)).toBe(season);
  });
});

describe("旅の長さ", () => {
  it("6時間以内の日帰りは半日のお出かけ、それより長ければ日帰り、2日以上は泊まり", () => {
    const outing = fictionalOuting();
    expect(tripLengthOf(outing)).toBe("outing");

    const long = structuredClone(outing);
    (long.days[0]?.items[0] as { start: string }).start = "13:00";
    expect(tripLengthOf(long)).toBe("day_trip");

    expect(tripLengthOf(fictionalWeekend())).toBe("overnight");
  });

  it("日をまたぐ予定は、次の日の時刻として長さを数える", () => {
    expect(
      daySpanMinutes([
        { start: "20:00", end: "21:00" },
        { start: "23:00", end: "01:00" },
      ]),
    ).toBe(300);
  });
});

describe("見た目の選び方", () => {
  const trip = (patch: (t: ShioriTrip) => void = () => {}) => {
    const t = fictionalOuting();
    patch(t);
    return t;
  };

  it("表紙の絵は祭りの種類、色は季節で決まり、夜の祭りは夜空の表紙になる", () => {
    const lantern = chooseDesign(trip(), { category: "lantern" }, "2026-08-16");
    expect(lantern).toMatchObject({ category: "lantern", season: "summer", coverTone: "night" });

    const dance = chooseDesign(trip(), { category: "dance" }, "2026-04-10");
    expect(dance).toMatchObject({ category: "dance", season: "spring", coverTone: "day" });
    expect(dance.palette.accent).not.toBe(lantern.palette.accent);
  });

  it("祭りのデータがなければ「その他」の絵にする", () => {
    expect(chooseDesign(trip(), undefined, "2026-10-01").category).toBe("other");
  });

  it("子ども連れとシニアと一緒で、ページの作りを変える", () => {
    const kids = chooseDesign(
      trip((t) => {
        t.party.children = 1;
      }),
      undefined,
      "2026-08-16",
    );
    const seniors = chooseDesign(
      trip((t) => {
        t.preferences.party = "seniors";
      }),
      undefined,
      "2026-08-16",
    );
    expect(kids).toMatchObject({ kids: true, largeText: false });
    expect(seniors).toMatchObject({ kids: false, largeText: true });
  });
});

describe("ページの並び", () => {
  const plan = (t: ShioriTrip, festivals = 1) =>
    pagePlan(chooseDesign(t, { category: "lantern" }, "2026-08-16"), t.days.length, festivals);

  it("半日のお出かけは表紙・流れ・作法・持ち物の4ページにまとめる", () => {
    expect(plan(fictionalOuting())).toEqual(["cover", "day", "guide", "checklist"]);
  });

  it("日帰りは祭りの紹介とスタンプ帳と出典のページを足す", () => {
    const t = fictionalOuting();
    (t.days[0]?.items[0] as { start: string }).start = "10:00";
    expect(plan(t)).toEqual([
      "cover",
      "festival",
      "day",
      "guide",
      "checklist",
      "stamps",
      "sources",
    ]);
  });

  it("泊まりの旅は日ごとにページが増え、表紙の次に旅の全体のページを置く", () => {
    const weekend = plan(fictionalWeekend());
    expect(count(weekend, "day")).toBe(2);
    expect(weekend.slice(0, 2)).toEqual(["cover", "overview"]);

    const week = plan(fictionalWeek(), 2);
    expect(count(week, "day")).toBe(7);
    expect(count(week, "festival")).toBe(2);
    expect(count(week, "guide")).toBe(2);
    expect(week.slice(0, 2)).toEqual(["cover", "overview"]);
    expect(week.at(-1)).toBe("sources");
  });
});
