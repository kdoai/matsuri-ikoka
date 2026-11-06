import type { Itinerary, SseEvent, VerificationResult } from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { shopRecord } from "../agent/briefing";
import { nextStage } from "../agent/runner";
import { refreshAnchorPlan } from "../domain/anchorPlan";
import { planHearing } from "../domain/hearing";
import { testFestival } from "../domain/testFestivals";
import type { CandidateCheck } from "./candidateCheck";
import {
  confirmAnchor,
  hearingSituation,
  noteConditions,
  searchFestivals,
  searchNearby,
  updateItinerary,
} from "./matsuriTools";
import { testToolContext } from "./testContext";

// 祭りを固定した旅程のときの、ツールと店の記録のふるまい。祭りと駅は架空。

const signal = new AbortController().signal;
const ANCHOR = { festivalId: "suzunari-toro", date: "2026-08-16" };
const suzunari = () => testFestival({ id: "suzunari-toro" });

function anchored(conditions = { origin: "みなと中央駅", nights: 0 }) {
  const ctx = testToolContext([suzunari(), testFestival({ id: "other-matsuri" })]);
  ctx.session.anchor = ANCHOR;
  ctx.session.selectedFestivalId = ANCHOR.festivalId;
  ctx.session.conditions = conditions;
  refreshAnchorPlan(ctx.session, { festival: suzunari(), today: ctx.today() });
  return ctx;
}

function draftOf(itinerary: Itinerary) {
  const { id: _id, version: _v, verification: _ver, days, ...rest } = itinerary;
  return {
    ...rest,
    days: days.map(({ weather: _w, items, ...day }) => ({
      ...day,
      items: items.map(({ changedInVersion: _c, ...item }) => item),
    })),
  };
}

function checker(result: VerificationResult, note?: string) {
  const calls: string[] = [];
  return {
    calls,
    candidateChecks: {
      async check({ festival, date }: { festival: { id: string }; date: string }) {
        calls.push(`${festival.id}@${date}`);
        return {
          festivalId: festival.id,
          date,
          checkedAt: "2026-08-03T10:00:00+09:00",
          cached: false,
          result,
          sources: [],
          ...(note === undefined ? {} : { note }),
        } as CandidateCheck;
      },
    },
  };
}

describe("update_itinerary（祭りを固定した旅程）", () => {
  it("守られていれば保存する", async () => {
    const ctx = anchored();
    const saved = await updateItinerary.run(
      { itinerary: { ...draftOf(fictionalItinerary()), origin: "みなと中央駅" } },
      ctx,
      signal,
    );
    // 出発の駅の検査など、ふだんの検査は別に動く。ここでは固定の誤りが出ないことを見る
    const codes = (saved.errors as { code: string }[]).map((e) => e.code);
    expect(codes.filter((code) => code.startsWith("anchor_"))).toEqual([]);
  });

  it("主役の祭りを変えた旅程は保存しない", async () => {
    const ctx = anchored();
    const result = await updateItinerary.run(
      { itinerary: { ...draftOf(fictionalItinerary()), mainFestivalId: "other-matsuri" } },
      ctx,
      signal,
    );
    expect(result.saved).toBe(false);
    expect((result.errors as { code: string }[]).map((e) => e.code)).toContain(
      "anchor_festival_changed",
    );
    expect(ctx.session.itineraryId).toBeNull();
  });

  it("祭りの日を変えた旅程は保存しない", async () => {
    const ctx = anchored();
    const draft = draftOf(fictionalItinerary());
    draft.days[0]!.date = "2026-08-17";
    const result = await updateItinerary.run({ itinerary: draft }, ctx, signal);

    expect(result.saved).toBe(false);
    expect((result.errors as { code: string }[]).map((e) => e.code)).toEqual(
      expect.arrayContaining(["anchor_date_missing", "anchor_outside_dates"]),
    );
  });

  it("入れる場所がないときは保存し、警告を返す", async () => {
    const ctx = testToolContext([suzunari()]);
    ctx.session.anchor = ANCHOR;
    ctx.session.anchorPlan = {
      anchor: ANCHOR,
      festivalName: "鈴鳴灯籠まつり",
      mustPrefectures: ["滋賀県"],
      visits: [{ name: "青森県", prefecture: "青森県", status: "included", reason: null }],
      order: ["みなと中央駅", "滋賀県鈴鳴町", "みなと中央駅"],
      startDate: ANCHOR.date,
      endDate: ANCHOR.date,
      minNights: 0,
      warnings: [],
    };
    const result = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );

    expect(result.saved).toBe(true);
    expect((result.warnings as { code: string }[]).map((w) => w.code)).toContain(
      "anchor_visit_missing",
    );
  });

  it("中止と分かった祭りの旅程は、固定を外したあとでも保存しない", async () => {
    const ctx = anchored();
    Object.assign(ctx, checker("cancelled"));
    await confirmAnchor(ctx);

    const result = await updateItinerary.run(
      { itinerary: draftOf(fictionalItinerary()) },
      ctx,
      signal,
    );
    expect(result.saved).toBe(false);
    expect((result.errors as { code: string }[]).map((e) => e.code)).toEqual(["anchor_cancelled"]);
  });
});

describe("confirmAnchor", () => {
  it("中止と分かったら固定を外し、結果へ戻り、店の記録で伝える", async () => {
    const ctx = anchored();
    const events: SseEvent[] = [];
    ctx.emit = (event) => events.push(event);
    Object.assign(ctx, checker("cancelled", "主催者が中止を発表"));

    await confirmAnchor(ctx);

    expect(ctx.session.anchor).toBeNull();
    expect(ctx.session.anchorPlan).toBeNull();
    expect(ctx.session.selectedFestivalId).toBeNull();
    expect(ctx.session.cancelledAnchor).toMatchObject({ ...ANCHOR, note: "主催者が中止を発表" });
    expect(nextStage("hearing", ctx.turn, false)).toBe("candidates");
    expect(events[0]).toMatchObject({
      type: "festival.verified",
      data: { festivalId: ANCHOR.festivalId, result: "cancelled", scope: "candidate" },
    });
    const record = shopRecord(ctx);
    expect(record).toContain("中止と分かった祭り");
    expect(record).toContain("主催者が中止を発表");
    expect(record).not.toContain("必ず行く祭り：");
  });

  it("開催が確かめられたら固定のまま進み、次の発言では確かめ直さない", async () => {
    const ctx = anchored();
    const { calls, candidateChecks } = checker("as_planned");
    ctx.candidateChecks = candidateChecks;

    await confirmAnchor(ctx);
    await confirmAnchor(ctx);

    expect(calls).toEqual([`${ANCHOR.festivalId}@${ANCHOR.date}`]);
    expect(ctx.session.anchor).toEqual(ANCHOR);
    expect(ctx.session.anchorCheck).toBe("as_planned");
    expect(ctx.turn.verification).toBeNull();
    expect(shopRecord(ctx)).toContain("必ず行く祭りの開催の確かめ：as_planned");
  });

  it("確かめる手段がないとき（mock やテスト）は、そのまま進む", async () => {
    const ctx = anchored();
    await confirmAnchor(ctx);
    expect(ctx.session.anchor).toEqual(ANCHOR);
    expect(ctx.session.anchorCheck).toBeNull();
  });
});

describe("聞き取り（祭りを固定した旅程）", () => {
  it("日付と旅のかたちを聞き直さず、祭りも探さない", () => {
    const plan = planHearing(
      { origin: "みなと中央駅", nights: 4 },
      { festivalChosen: true, anchored: true },
    );

    expect(plan.readyToSearch).toBe(false);
    expect(plan.missing).not.toContain("when");
    expect(plan.missing).not.toContain("route");
    expect(plan.ask).toEqual([]);
  });

  it("出発地と泊数は聞く", () => {
    const plan = planHearing({}, { festivalChosen: true, anchored: true });
    expect(plan.ask).toEqual(["origin", "nights"]);
  });

  it("日帰りは、そろえばすぐ組める", () => {
    const plan = planHearing(
      { origin: "みなと中央駅", nights: 0 },
      { festivalChosen: true, anchored: true },
    );
    expect(plan).toMatchObject({ missing: [], readyToPlan: true, readyToSearch: false });
  });

  it("相談の状態から、固定と行く日を読む", () => {
    expect(hearingSituation(anchored())).toMatchObject({ festivalChosen: true, anchored: true });
  });
});

describe("note_conditions（祭りを固定した旅程）", () => {
  it("条件が変わると組み立てを計算し直し、行く日は変えない", async () => {
    const ctx = anchored();
    expect(ctx.session.anchorPlan?.endDate).toBe(ANCHOR.date);

    const result = await noteConditions.run(
      { nights: 1, route: { shape: "auto", areas: ["鈴鳴温泉"] } },
      ctx,
      signal,
    );

    expect(ctx.session.anchorPlan?.endDate).toBe("2026-08-17");
    expect(ctx.session.anchorPlan?.visits[0]?.name).toBe("鈴鳴温泉");
    expect(ctx.session.anchorPlan?.anchor).toEqual(ANCHOR);
    expect(result).toMatchObject({ readyToSearch: false });

    // モデルが別の日を書き留めても、固定した日を正とする
    await noteConditions.run({ when: { kind: "date", date: "2026-09-01" } }, ctx, signal);
    expect(ctx.session.conditions.when).toEqual({
      kind: "range",
      from: ANCHOR.date,
      to: "2026-08-17",
    });
  });

  it("ほかの祭りに変えたいと言われたら、固定を外して結果へ戻る", async () => {
    const ctx = anchored();
    await noteConditions.run({ releaseAnchor: true }, ctx, signal);

    expect(ctx.session.anchor).toBeNull();
    expect(ctx.session.anchorPlan).toBeNull();
    expect(nextStage("hearing", ctx.turn, false)).toBe("candidates");
    expect(ctx.session.conditions).not.toHaveProperty("releaseAnchor");
  });
});

describe("固定のときの道具", () => {
  it("祭りを探さない", async () => {
    await expect(
      searchFestivals.run(
        { when: { kind: "date", date: ANCHOR.date }, origin: "みなと中央駅", nights: 0 },
        anchored(),
        signal,
      ),
    ).rejects.toThrow("祭りを探さず");
  });

  it("寄り道を探しても、選んだ祭りを変えない。日を省くと固定した日を使う", async () => {
    const ctx = anchored();
    const result = await searchNearby.run({ festivalId: "other-matsuri" }, ctx, signal);
    expect(ctx.session.selectedFestivalId).toBe(ANCHOR.festivalId);
    expect(result.festivalId).toBe("other-matsuri");

    const own = await searchNearby.run({ festivalId: ANCHOR.festivalId }, ctx, signal);
    expect(own.date).toBe(ANCHOR.date);
  });
});

describe("店の記録（祭りを固定した旅程）", () => {
  it("必ず行く祭り・行く日・入れる場所・余裕があれば入れる場所・外す場所と理由を載せる", () => {
    const ctx = anchored();
    ctx.session.anchorPlan = {
      anchor: ANCHOR,
      festivalName: "鈴鳴灯籠まつり",
      mustPrefectures: ["滋賀県"],
      visits: [
        { name: "京都", prefecture: "京都府", status: "included", reason: null },
        { name: "鈴鳴温泉", prefecture: null, status: "maybe", reason: "判断を渡します" },
        { name: "青森県", prefecture: "青森県", status: "dropped", reason: "遠いので外します" },
      ],
      order: ["みなと中央駅", "京都府", "滋賀県鈴鳴町", "みなと中央駅"],
      startDate: "2026-08-16",
      endDate: "2026-08-17",
      minNights: 2,
      warnings: ["泊数が足りません"],
    };

    const record = shopRecord(ctx);

    expect(record).toContain("必ず行く祭り：");
    expect(record).toContain("suzunari-toro");
    expect(record).toContain("2026-08-16");
    expect(record).toContain("祭り調査係は呼びません");
    expect(record).toContain("旅の日付：2026-08-16〜2026-08-17");
    expect(record).toContain("回る順：みなと中央駅→京都府→滋賀県鈴鳴町→みなと中央駅");
    expect(record).toContain("入れる場所：滋賀県、京都（京都府）");
    expect(record).toContain("余裕があれば入れる場所：鈴鳴温泉：判断を渡します");
    expect(record).toContain("今回は外す場所と理由：青森県：遠いので外します");
    expect(record).toContain("注意：泊数が足りません");
    expect(record).toContain("聞き取り：まだ探さない");
  });

  it("固定がなければ載せない", () => {
    const ctx = testToolContext([suzunari()]);
    expect(shopRecord(ctx)).not.toContain("必ず行く祭り");
  });
});
