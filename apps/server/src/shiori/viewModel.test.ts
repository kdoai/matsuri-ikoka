import { FestivalSchema } from "@matsuri-ikoka/schema";
import {
  fictionalFestival,
  fictionalItinerary,
  fictionalLodgingSearch,
  fictionalResearchedLodgingSearch,
  fictionalSource,
} from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import {
  fictionalFestivals,
  fictionalOuting,
  fictionalWeek,
  fictionalWeekend,
  lookupOf,
  SECOND_FESTIVAL_ID,
} from "./testTrips";
import { toShioriTrip } from "./trip";
import { buildShioriView, NEEDS_CHECK_LABEL, UNKNOWN_JA } from "./viewModel";

const lookup = lookupOf(fictionalFestivals());

describe("旅程からしおりの形へ", () => {
  it("旅程の日ごとの予定をそのまま持つ", () => {
    const itinerary = fictionalItinerary();
    const trip = toShioriTrip(itinerary);

    expect(trip.days).toBe(itinerary.days);
    expect(trip.budget).toBeUndefined();
    expect(toShioriTrip({ ...itinerary, budget: { yen: 90000, basis: "total" } }).budget).toEqual({
      yen: 90000,
      basis: "total",
    });
  });
});

describe("しおりの view-model", () => {
  it("表紙に旅の長さ・日にち・同行者・主役の祭りを出す", () => {
    const view = buildShioriView(fictionalWeek(), lookup);

    expect(view.cover).toMatchObject({
      lengthLabel: "6泊7日の旅",
      dateLabel: "8月14日（金）〜8月20日（木）",
      partyLabel: "大人2人",
      festivalName: "鈴鳴灯籠まつり",
      festivalNameEn: "Suzunari Lantern Festival",
    });
    expect(view.cover.verifiedLabel).toContain("公式情報で開催予定を確認済み");
    expect(buildShioriView(fictionalOuting(), lookup).cover.lengthLabel).toBe("半日のお出かけ");
  });

  it("表紙の予算は、言われた数え方と、人数で換算したもう一方を書く", () => {
    const trip = fictionalOuting();
    expect(buildShioriView(trip, lookup).cover.budgetLabel).toBeNull();
    trip.budget = { yen: 30000, basis: "perPerson" };
    expect(buildShioriView(trip, lookup).cover.budgetLabel).toBe(
      "1人あたり 30,000円まで（全員で 60,000円）",
    );
    trip.budget = { yen: 50000, basis: "total" };
    expect(buildShioriView(trip, lookup).cover.budgetLabel).toBe(
      "全員で 50,000円まで（1人あたり 25,000円）",
    );
  });

  it("確認できていない旅程には、確認済みの印を出さない", () => {
    const trip = fictionalOuting();
    trip.verification = { status: "pending" };
    expect(buildShioriView(trip, lookup).cover.verifiedLabel).toBeNull();
    expect(buildShioriView(trip, lookup).cover.needsCheckLabel).toBeNull();
  });

  it("要事前確認の旅程には、出発の前に確かめるよう注意を出す", () => {
    const trip = fictionalOuting();
    trip.verification = {
      status: "needs_check",
      checkedAt: "2026-08-03T10:00:00+09:00",
      sources: [fictionalSource("news", "single")],
    };
    const { cover } = buildShioriView(trip, lookup);
    expect(cover.verifiedLabel).toBeNull();
    expect(cover.needsCheckLabel).toBe(NEEDS_CHECK_LABEL);
  });

  it("日ごとに、出発・時刻の流れ・泊まる地域・帰りを出す", () => {
    const view = buildShioriView(fictionalWeekend(), lookup);
    const [first, second] = view.days;

    expect(first).toMatchObject({
      heading: "1日目",
      startLabel: "みなと中央駅から出発",
      stay: { area: "鈴鳴駅の周り", note: "祭りの夜は混むので、早めに予約を" },
      returnLabel: null,
    });
    expect(second).toMatchObject({
      heading: "2日目",
      startLabel: "鈴鳴駅の周りから出発",
      stay: null,
      returnLabel: "みなと中央駅に帰る",
    });
    const festivalRow = first?.rows.find((r) => r.festival);
    expect(festivalRow).toMatchObject({ time: "18:30〜21:00", icon: "festival", kind: "祭り" });
    const craftRow = first?.rows.find((r) => r.name === "鈴鳴和紙の館");
    expect(craftRow?.details).toEqual([
      "徒歩 5〜10分（目安）",
      "営業 10:00〜17:00（最終入場 16:30）",
      "費用 和紙すき体験 600円",
    ]);
  });

  it("泊まりに宿の候補があれば、名前・会場からの目安・料金の目安・調べた日と注意を出す", () => {
    const trip = fictionalWeekend();
    trip.days[0]!.stay = { area: "鈴鳴駅の周り", lodging: fictionalResearchedLodgingSearch() };
    const stay = buildShioriView(trip, lookup).days[0]?.stay;

    expect(stay?.offers).toEqual([
      {
        name: "鈴鳴川の宿",
        url: "https://example.com/inn/kawa",
        details: [
          "会場から約0.1km・徒歩1〜2分（目安）",
          "1泊1人 8,000円〜11,000円（宿のページの目安）",
        ],
        summary: "河原まで歩いてすぐの、和室のある宿",
      },
      {
        name: "鈴鳴駅前ホテル",
        url: "https://example.com/inn/ekimae",
        details: ["会場から約1.1km・徒歩13〜22分（目安）", "1室 12,000円から"],
        summary: null,
      },
    ]);
    expect(stay?.lodgingNotes[0]).toContain("空きは調べていない");
  });

  it("空室検索の宿には、1泊の合計とクレジットを添える", () => {
    const trip = fictionalWeekend();
    trip.days[0]!.stay = {
      area: "鈴鳴駅の周り",
      lodging: { ...fictionalLodgingSearch(), provider: "rakuten" },
    };
    const stay = buildShioriView(trip, lookup).days[0]?.stay;

    expect(stay?.offers[0]?.details).toEqual(["1泊 全員で24,000円から"]);
    expect(stay?.lodgingNotes).toContain("Supported by Rakuten Developers");
  });

  it("雨の日・中止のときの案は、主役の祭りの日に出す", () => {
    const view = buildShioriView(fictionalWeek(), lookup);
    const withRain = view.days.filter((d) => d.rainPlan.length > 0).map((d) => d.number);

    expect(withRain).toEqual([3]);
    expect(view.days[2]?.rainPlan[0]).toBe("雨天の扱い：小雨決行。荒天の場合は翌日に順延");
  });

  it("旅程に出てくる祭りを、主役から順に紹介する", () => {
    const view = buildShioriView(fictionalWeek(), lookup);

    expect(view.festivals.map((f) => f.id)).toEqual(["suzunari-toro", SECOND_FESTIVAL_ID]);
    expect(view.festivals[0]?.when).toEqual(["8月16日（日） 18:30〜21:00"]);
    expect(view.festivals[1]?.food.stalls).toBe(`屋台は${UNKNOWN_JA}`);
  });

  it("作法の分からない項目は「分からない」と出し、英語の見出しを添える", () => {
    const view = buildShioriView(fictionalWeek(), lookup);
    const guide = view.guides[1];
    const byLabel = Object.fromEntries((guide?.rows ?? []).map((r) => [r.labelJa, r]));

    expect(byLabel["服装"]).toMatchObject({
      valuesJa: [UNKNOWN_JA],
      valueEn: "Unknown",
      unknown: true,
      labelEn: "What to wear",
    });
    expect(byLabel["見学か参加か"]).toMatchObject({
      valuesJa: ["見学のみ"],
      valueEn: "Watch only",
    });
    expect(byLabel["申し込み"]).toBeUndefined();
    expect(guide?.requests).toEqual(["打ち上げの場所の近くには入らない"]);
  });

  it("祭りの側からのお願いに、ルールと写真の制限をまとめる", () => {
    const view = buildShioriView(fictionalOuting(), lookup);

    expect(view.guides[0]?.requests).toEqual([
      "灯籠は係の合図のあとに流す",
      "立入禁止の縄の内側に入らない",
      "写真：制限がある（神事の間はフラッシュを使わない）",
    ]);
    expect(view.guides[0]?.cautions).toContain(
      "交通規制：17時から22時まで、河原沿いの道は車両通行止め",
    );
  });

  it("祭りのデータが見つからなければ、名前は旅程から取り、ほかは分からないと出す", () => {
    const view = buildShioriView(fictionalOuting(), () => undefined);

    expect(view.festivals[0]).toMatchObject({
      nameJa: "鈴鳴灯籠まつり",
      missing: true,
      venue: UNKNOWN_JA,
    });
    expect(view.guides[0]).toMatchObject({ missing: true, rows: [] });
    expect(view.design.category).toBe("other");
  });

  it("持ち物は、祭りのデータ・旅程のメモ・一般の目安・泊まり・子どもの順にまとめる", () => {
    const trip = fictionalWeekend();
    trip.party.children = 1;
    const groups = buildShioriView(trip, lookup).checklist;

    expect(groups.map((g) => g.title)).toEqual([
      "祭りのために",
      "旅程係のメモ",
      "いつもの持ち物",
      "泊まりの分（1泊）",
      "子どもと一緒",
    ]);
    expect(groups[0]?.items).toEqual(["懐中電灯", "歩きやすい靴"]);
    // 2日目の降水確率が 60% なので、雨具を先頭に出す
    expect(groups[2]?.items[0]).toBe("雨具（降水確率が高い日があります）");
  });

  it("スタンプ帳は日ごとと祭りごとの枠を出し、9つまでにする", () => {
    const week = buildShioriView(fictionalWeek(), lookup);
    expect(week.stamps).toHaveLength(9);
    expect(week.stamps[0]).toEqual({ label: "1日目", sub: "8月14日" });
    expect(week.stamps.slice(7).map((s) => s.label)).toEqual(["鈴鳴灯籠まつり", "星見浜の花火"]);

    const outing = buildShioriView(fictionalOuting(), lookup);
    expect(outing.stamps.map((s) => s.label)).toEqual([
      "鈴鳴灯籠まつり",
      "見つけたもの",
      "おいしかったもの",
      "おみやげ",
    ]);
  });

  it("出典は URL の重なりを除いて集め、題名がなければ URL だけを出す", () => {
    const view = buildShioriView(fictionalWeek(), lookup);
    const urls = view.sources.map((s) => s.url);

    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain("https://example.com/suzunari/2026");
    expect(urls).toContain("https://example.com/suzunari/hoshimi-2026");
    expect(view.sources.every((s) => s.title === null)).toBe(true);
    expect(view.sources[0]?.confidence).toBe("公式");
  });

  it("見どころは3つまで、小話は2つまでにする", () => {
    const festival = fictionalFestival();
    festival.highlights = ["一", "二", "三", "四"];
    const view = buildShioriView(fictionalOuting(), lookupOf([FestivalSchema.parse(festival)]));
    expect(view.festivals[0]?.highlights).toEqual(["一", "二", "三"]);
  });
});
