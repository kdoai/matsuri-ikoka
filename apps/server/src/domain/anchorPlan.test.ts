import { readFileSync } from "node:fs";
import { AnchorPlanSchema, type Prefecture } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import {
  type AnchoredDraft,
  type AnchorPlanInput,
  anchorWishes,
  checkAnchoredItinerary,
  computeAnchorPlan,
  refreshAnchorPlan,
  refuseAnchor,
} from "./anchorPlan";
import { distanceKm } from "./lodging";
import { nearestPrefecture, PREFECTURE_POINTS } from "./prefecturePoints";
import { testFestival } from "./testFestivals";
import { createStationPointIndex, type StationPoint } from "./travelEstimate";

// 架空の祭りと架空の駅で確かめる。都道府県の名前は、表に当てるために実際の名前を使う。

const VENUE = { lat: 35.0, lng: 136.0 };
const ANCHOR = { festivalId: "suzunari-toro", date: "2026-08-16" };

/** 開催地が滋賀県で、会場の近くから出発できる架空の祭り */
function festival(options: { start?: string | null; end?: string | null } = {}) {
  return testFestival({
    id: "suzunari-toro",
    fromHubMinutes: null,
    ...options,
    edit: (f) => {
      f.venue.lat = VENUE.lat;
      f.venue.lng = VENUE.lng;
      f.municipalities = [{ prefecture: "滋賀県", name: "鈴鳴町" }];
    },
  });
}

const POINTS: StationPoint[] = [
  ["鈴鳴", VENUE.lat, VENUE.lng + 0.01],
  ["みなと中央", 34.9, 135.9],
  ["遠い北", 43.0, 141.3],
  ["東の都", 35.68, 139.76],
];
const stations = createStationPointIndex(POINTS);

function plan(input: Partial<AnchorPlanInput> = {}) {
  return computeAnchorPlan(
    {
      festival: festival(),
      anchor: ANCHOR,
      origin: "みなと中央駅",
      nights: 1,
      wishes: [],
      today: "2026-08-03",
      ...input,
    },
    stations,
  );
}

describe("computeAnchorPlan", () => {
  it("遠い県を挙げても祭りは必ず入り、入らない場所は理由つきで外れる", () => {
    const result = plan({ wishes: ["北海道", "沖縄県", "青森県"], nights: 0 });

    expect(AnchorPlanSchema.safeParse(result).success).toBe(true);
    expect(result.mustPrefectures).toEqual(["滋賀県"]);
    expect(result.order.join()).toContain("滋賀県鈴鳴町");
    expect(result.startDate <= ANCHOR.date && ANCHOR.date <= result.endDate).toBe(true);
    const statuses = result.visits.map((v) => v.status);
    expect(statuses.filter((s) => s === "maybe")).toHaveLength(1);
    expect(statuses.filter((s) => s === "dropped")).toHaveLength(2);
    expect(statuses).not.toContain("included");
    for (const visit of result.visits) expect(visit.reason).toBeTruthy();
    // 入らない場所は回る順に出さない
    expect(result.order.join()).not.toContain("北海道");
  });

  it("近い県は泊数に余裕があれば入れ、回る順と日付に反映する", () => {
    const result = plan({ wishes: ["京都府", "奈良県"], nights: 2 });

    expect(result.visits.map((v) => [v.name, v.status])).toEqual([
      ["京都府", "included"],
      ["奈良県", "included"],
    ]);
    expect(result.order[0]).toBe("みなと中央駅");
    expect(result.order.at(-1)).toBe("みなと中央駅");
    expect(result.order).toEqual(expect.arrayContaining(["京都府", "奈良県", "滋賀県鈴鳴町"]));
    expect(result.endDate).not.toBe(result.startDate);
  });

  it("寄り道の増える時間が少ない場所から入れ、次の1か所を maybe、ほかを dropped にする", () => {
    const result = plan({ wishes: ["北海道", "京都府", "沖縄県"], nights: 1 });

    expect(result.visits.find((v) => v.name === "京都府")?.status).toBe("included");
    expect(result.visits.find((v) => v.name === "北海道")?.status).toBe("maybe");
    expect(result.visits.find((v) => v.name === "沖縄県")?.status).toBe("dropped");
  });

  it("祭りと同じ県は計算するまでもなく入れる", () => {
    const result = plan({ wishes: ["滋賀", "滋賀県"], nights: 0 });

    expect(result.visits.map((v) => v.status)).toEqual(["included", "included"]);
    expect(result.visits.map((v) => v.prefecture)).toEqual(["滋賀県", "滋賀県"]);
    expect(result.order).toEqual(["みなと中央駅", "滋賀県鈴鳴町", "みなと中央駅"]);
  });

  it("地方の名前は、その中で祭りにいちばん近い県に当てる（祭りの県を含む地方は祭りの県）", () => {
    const result = plan({ wishes: ["四国", "近畿"], nights: 3 });

    const [shikoku, kinki] = result.visits;
    expect(shikoku?.prefecture).toBe(
      nearestPrefecture(VENUE, ["徳島県", "香川県", "愛媛県", "高知県"]),
    );
    expect(shikoku?.reason).toContain("四国の中で");
    expect(kinki).toMatchObject({ prefecture: "滋賀県", status: "included" });
  });

  it("同じ県に当たる名前は、同じ判断にする", () => {
    const result = plan({ wishes: ["京都", "京都府"], nights: 1 });
    expect(result.visits[0]?.status).toBe(result.visits[1]?.status);
  });

  it("都道府県に当たらない地名は maybe にして旅程係に渡す", () => {
    const result = plan({ wishes: ["鈴鳴温泉"] });

    expect(result.visits[0]).toMatchObject({ prefecture: null, status: "maybe" });
    expect(result.visits[0]?.reason).toContain("都道府県に当たらない");
  });

  it("日帰りで届かない祭りは、警告と要る泊数を返す（旅程は作れる）", () => {
    const result = plan({ origin: "遠い北駅", nights: 0 });

    expect(result.startDate).toBe(ANCHOR.date);
    expect(result.endDate).toBe(ANCHOR.date);
    expect(result.minNights).toBeGreaterThan(0);
    expect(result.warnings.join()).toContain("日帰りでは");
  });

  it("近い祭りは日帰りでよく、警告を出さない", () => {
    const result = plan({ nights: 0 });

    expect(result.minNights).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("夜の祭りに片道の長いところから日帰りすると、終電に間に合わないので泊まりを勧める", () => {
    const result = plan({
      festival: festival({ start: "18:00", end: null }),
      origin: "東の都駅",
      nights: 0,
    });

    expect(result.minNights).toBeGreaterThanOrEqual(1);
    expect(result.warnings.join()).toContain("日帰りでは");
  });

  it("夜の祭りでも、1泊するなら注意を出さない", () => {
    const result = plan({
      festival: festival({ start: "18:00", end: null }),
      origin: "東の都駅",
      nights: 1,
    });

    expect(result.minNights).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("昼に終わる祭りは、片道が長くても日帰りできる", () => {
    const result = plan({
      festival: festival({ start: "12:00", end: "14:00" }),
      origin: "東の都駅",
      nights: 0,
    });

    expect(result.minNights).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  describe("利用者が初日を決めたとき", () => {
    const fixed = (startDate: string) => ({ ...ANCHOR, startDate });

    it("回る順で前に寄れるときも、決めた日程を変えない", () => {
      const result = plan({ anchor: fixed("2026-08-15"), nights: 2 });

      expect(result.startDate).toBe("2026-08-15");
      expect(result.endDate).toBe("2026-08-17");
    });

    it("祭りの日を初日にしたら、遠い場所は祭りのあとに回すか外し、前にずらさない", () => {
      const result = plan({ anchor: fixed(ANCHOR.date), nights: 1, wishes: ["京都府"] });

      expect(result.startDate).toBe(ANCHOR.date);
      expect(result.order.indexOf("滋賀県鈴鳴町")).toBe(1);
    });

    it("決めた日程では祭りに間に合わないとき、日程を変えずに注意を出す", () => {
      const morning = festival({ start: "08:00", end: "11:00" });
      const result = plan({
        festival: morning,
        anchor: fixed(ANCHOR.date),
        origin: "東の都駅",
        nights: 1,
      });

      expect(result.startDate).toBe(ANCHOR.date);
      expect(result.warnings.join()).toContain("開始に間に合わない");
    });

    it("祭りの日を最後の日にして帰れないとき、注意を出す", () => {
      const evening = festival({ start: "18:00", end: "21:00" });
      const result = plan({
        festival: evening,
        anchor: fixed("2026-08-15"),
        origin: "東の都駅",
        nights: 1,
      });

      expect(result.endDate).toBe(ANCHOR.date);
      expect(result.warnings.join()).toContain("帰り着けない");
    });

    it("過ぎた日や、泊数に祭りの日が入らない初日は使わない", () => {
      expect(plan({ anchor: fixed("2026-08-01"), nights: 1 }).startDate).toBe(ANCHOR.date);
      expect(plan({ anchor: fixed("2026-08-10"), nights: 1 }).startDate).toBe(ANCHOR.date);
    });
  });

  it("朝に始まる祭りに遠くから行くときは、初日を前にずらす", () => {
    const result = plan({
      festival: festival({ start: "08:00", end: "11:00" }),
      origin: "遠い北駅",
      nights: 1,
    });

    expect(result.startDate).toBe("2026-08-15");
    expect(result.endDate).toBe("2026-08-16");
  });

  it("夜の祭りの日帰りでは、寄る場所を祭りの前に置く", () => {
    const result = plan({ wishes: ["京都府"], nights: 0 });

    expect(result.visits[0]?.status).toBe("included");
    expect(result.order).toEqual(["みなと中央駅", "京都府", "滋賀県鈴鳴町", "みなと中央駅"]);
  });

  it("祭りの日が今日なら、初日を前にずらさず、祭りを最初にする", () => {
    const result = plan({
      festival: festival({ start: "08:00", end: "11:00" }),
      origin: "遠い北駅",
      nights: 1,
      today: ANCHOR.date,
    });

    expect(result.startDate).toBe(ANCHOR.date);
  });

  it("ペースで使える時間が変わる（たっぷりなら入るものが、ゆっくりでは入らない）", () => {
    const wishes = ["京都府", "奈良県", "大阪府", "兵庫県", "三重県"];
    const count = (pace: AnchorPlanInput["pace"]) =>
      plan({ wishes, nights: 1, pace }).visits.filter((v) => v.status === "included").length;

    expect(count("packed")).toBeGreaterThan(count("relaxed"));
  });

  it("出発の駅の位置が分からなければ、判断できない場所は maybe、minNights は null", () => {
    const result = plan({ origin: "どこにもない駅", wishes: ["京都府", "鈴鳴温泉", "滋賀県"] });

    expect(result.minNights).toBeNull();
    expect(result.visits.map((v) => v.status)).toEqual(["maybe", "maybe", "included"]);
    expect(result.visits[0]?.reason).toContain("出発の駅の位置が分からず");
    expect(result.warnings.join()).toContain("見積もれません");
    expect(result.startDate).toBe(ANCHOR.date);
  });

  it("駅の位置がなくても、データの主要駅からの所要時間で要る泊数は出す", () => {
    const withHub = testFestival({ id: "suzunari-toro", fromHubMinutes: [40, 50] });
    const result = computeAnchorPlan({
      festival: withHub,
      anchor: ANCHOR,
      origin: "みなと中央駅",
      nights: 0,
      wishes: ["京都府"],
      today: "2026-08-03",
    });

    expect(result.minNights).toBe(0);
    expect(result.visits[0]?.status).toBe("maybe");
  });

  it("何日かにまたがる開催の、途中の日を行く日にできる", () => {
    const result = plan({
      festival: testFestival({ id: "suzunari-toro", date: "2026-08-15", endDate: "2026-08-17" }),
    });
    expect(result.anchor.date).toBe(ANCHOR.date);
  });

  it("開催回のない日は計算しない", () => {
    expect(() => plan({ anchor: { ...ANCHOR, date: "2026-09-01" } })).toThrow();
  });
});

describe("refuseAnchor", () => {
  it("祭りがない・掲載停止は 404", () => {
    expect(refuseAnchor(undefined, ANCHOR.date, null)?.status).toBe(404);
    const hidden = testFestival({ id: "suzunari-toro", optOut: true });
    expect(refuseAnchor(hidden, ANCHOR.date, null)?.status).toBe(404);
  });

  it("データにない日、中止と延期の回、過ぎた日は 400", () => {
    expect(refuseAnchor(festival(), "2026-08-17", null)?.status).toBe(400);
    const cancelled = testFestival({ id: "suzunari-toro", status: "cancelled" });
    expect(refuseAnchor(cancelled, ANCHOR.date, null)?.status).toBe(400);
    const postponed = testFestival({ id: "suzunari-toro", status: "postponed" });
    expect(refuseAnchor(postponed, ANCHOR.date, null)?.status).toBe(400);
    expect(refuseAnchor(festival(), ANCHOR.date, "2026-08-17")?.status).toBe(400);
  });

  it("開催回の中の今日以降の日は受ける", () => {
    expect(refuseAnchor(festival(), ANCHOR.date, ANCHOR.date)).toBeNull();
  });
});

describe("refreshAnchorPlan", () => {
  it("出発地か泊数がそろうまでは組み立てを作らず、希望日は行く日にする", () => {
    const state = {
      anchor: ANCHOR,
      anchorPlan: null,
      conditions: { origin: "みなと中央駅" },
    };
    refreshAnchorPlan(state, { festival: festival(), stations, today: "2026-08-03" });

    expect(state.anchorPlan).toBeNull();
    expect(state.conditions).toMatchObject({ when: { kind: "date", date: ANCHOR.date } });
  });

  it("そろったら、回りたい地域と行き先を寄りたい場所にして計算し、希望日を旅の日付にする", () => {
    const state: Parameters<typeof refreshAnchorPlan>[0] = {
      anchor: ANCHOR,
      anchorPlan: null,
      conditions: {
        origin: "みなと中央駅",
        nights: 1,
        route: { shape: "loop", areas: ["京都府"] },
        destinations: ["京都府", "奈良県"],
      },
    };
    refreshAnchorPlan(state, { festival: festival(), stations, today: "2026-08-03" });

    expect(state.anchorPlan?.visits.map((v) => v.name)).toEqual(["京都府", "奈良県"]);
    expect(state.conditions.when).toEqual({
      kind: "range",
      from: state.anchorPlan?.startDate,
      to: state.anchorPlan?.endDate,
    });
  });

  it("固定がなければ組み立てを消す", () => {
    const state: Parameters<typeof refreshAnchorPlan>[0] = {
      anchor: null,
      anchorPlan: plan(),
      conditions: {},
    };
    refreshAnchorPlan(state, { festival: undefined, today: "2026-08-03" });
    expect(state.anchorPlan).toBeNull();
  });

  it("寄りたい場所は多くても上限まで", () => {
    const areas = ["京都府", "奈良県", "大阪府", "兵庫県", "三重県"];
    expect(anchorWishes({ route: { shape: "loop", areas }, destinations: ["岐阜県"] })).toEqual(
      areas,
    );
  });
});

describe("checkAnchoredItinerary", () => {
  const anchored = plan({ wishes: ["京都府"], nights: 1 });
  const prefecturesOf = (id: string): Prefecture[] => (id === "other-matsuri" ? ["京都府"] : []);
  const festivalItem = {
    id: "festival",
    type: "festival",
    name: "鈴鳴灯籠まつり",
    festivalId: ANCHOR.festivalId,
  };
  const inKyoto = { id: "kyoto", type: "sightseeing", name: "京都の庭" };
  const draft = (over: Partial<AnchoredDraft> = {}): AnchoredDraft => ({
    mainFestivalId: ANCHOR.festivalId,
    days: [
      { date: anchored.startDate, items: [festivalItem] },
      { date: anchored.endDate, items: [inKyoto] },
    ],
    ...over,
  });
  const codes = (d: AnchoredDraft) => {
    const { errors, warnings } = checkAnchoredItinerary(d, ANCHOR, anchored, prefecturesOf);
    return { errors: errors.map((e) => e.code), warnings: warnings.map((w) => w.code) };
  };

  it("守られていれば、誤りも警告もない", () => {
    expect(codes(draft())).toEqual({ errors: [], warnings: [] });
  });

  it("主役の祭りを変えた旅程は誤り", () => {
    expect(codes(draft({ mainFestivalId: "other-matsuri" })).errors).toContain(
      "anchor_festival_changed",
    );
  });

  it("祭りの日に祭りの予定がない旅程は誤り", () => {
    const moved = draft({
      days: [
        { date: "2026-08-17", items: [festivalItem] },
        { date: "2026-08-16", items: [inKyoto] },
      ],
    });
    expect(codes(moved).errors).toContain("anchor_date_missing");
  });

  it("旅の日付から出る日があれば誤り", () => {
    const longer = draft({
      days: [...draft().days, { date: "2026-08-20", items: [inKyoto] }],
    });
    expect(codes(longer).errors).toContain("anchor_outside_dates");
  });

  it("入れる場所がなければ警告にとどめる", () => {
    const without = draft({
      days: [
        { date: anchored.startDate, items: [festivalItem] },
        { date: anchored.endDate, items: [{ id: "free", type: "free", name: "自由に過ごす" }] },
      ],
    });
    expect(codes(without)).toEqual({ errors: [], warnings: ["anchor_visit_missing"] });
  });

  it("入れる場所は、泊まる地域・場所の位置・別の祭りの開催地でも認める", () => {
    const withDay = (day: AnchoredDraft["days"][number]) =>
      draft({ days: [{ date: anchored.startDate, items: [festivalItem] }, day] });
    const free = { id: "x", type: "free", name: "自由に過ごす" };

    expect(
      codes(withDay({ date: anchored.endDate, stay: { area: "京都市内" }, items: [free] }))
        .warnings,
    ).toEqual([]);
    expect(
      codes(
        withDay({
          date: anchored.endDate,
          items: [{ ...free, location: PREFECTURE_POINTS["京都府"] }],
        }),
      ).warnings,
    ).toEqual([]);
    expect(
      codes(withDay({ date: anchored.endDate, items: [{ ...free, festivalId: "other-matsuri" }] }))
        .warnings,
    ).toEqual([]);
  });

  it("組み立てがまだなくても、主役の祭りと日は確かめる", () => {
    const { errors } = checkAnchoredItinerary(
      draft({ mainFestivalId: "other-matsuri" }),
      ANCHOR,
      null,
      prefecturesOf,
    );
    expect(errors.map((e) => e.code)).toEqual(["anchor_festival_changed"]);
  });
});

describe("都道府県の代表の位置", () => {
  it("どの県も、駅の位置のデータ（data/stations）にある駅の位置と一致する", () => {
    const file = new URL("../../../../data/stations/points.json", import.meta.url);
    const data = JSON.parse(readFileSync(file, "utf8")) as { points: StationPoint[] };
    const points = data.points.map(([, lat, lng]) => ({ lat, lng }));
    for (const [prefecture, point] of Object.entries(PREFECTURE_POINTS)) {
      const near = points.some((p) => distanceKm(p, point) < 0.05);
      expect(near, prefecture).toBe(true);
    }
    expect(Object.keys(PREFECTURE_POINTS)).toHaveLength(47);
  });
});
