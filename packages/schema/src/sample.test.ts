import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Festival, FestivalSchema } from "./festival";
import { tripPhase } from "./guide";
import { type Itinerary, itineraryItems } from "./itinerary";
import { DEFAULT_PREFERENCES } from "./preferences";
import {
  type RecordedEvent,
  type RecordedGuideEvent,
  SampleConversationSchema,
  SampleGuideSchema,
  SampleGuideTurnSchema,
  SamplePatrolSchema,
  SampleTurnSchema,
} from "./sample";
import { fictionalPatrolReport, fictionalPatrolRequest } from "./testing";

const SAMPLES_DIR = new URL("../../../data/samples/", import.meta.url);

function readJsonFiles(dir: string): [string, unknown][] {
  const url = new URL(`${dir}/`, SAMPLES_DIR);
  return readdirSync(url)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [name, JSON.parse(readFileSync(new URL(name, url), "utf8"))]);
}

const request = { message: "8月16日に行ける祭りはありますか", preferences: DEFAULT_PREFERENCES };
const done: RecordedEvent = {
  atMs: 900,
  event: {
    type: "done",
    data: { stage: "hearing", conditions: {}, preferences: { ...DEFAULT_PREFERENCES } },
  },
};
const toolStart: RecordedEvent = {
  atMs: 100,
  event: {
    type: "tool.start",
    data: {
      toolCallId: "call-1",
      tool: "get_weather",
      staff: "planner",
      bubble: "天気を確かめています",
    },
  },
};
const toolEnd: RecordedEvent = {
  atMs: 500,
  event: {
    type: "tool.end",
    data: {
      toolCallId: "call-1",
      tool: "get_weather",
      staff: "planner",
      ok: true,
      bubble: "確かめました",
      count: null,
    },
  },
};

describe("SampleTurnSchema", () => {
  it("ツールの開始と終了のあとに done で終わる返答を受け付ける", () => {
    const turn = { request, events: [toolStart, toolEnd, done] };
    expect(SampleTurnSchema.safeParse(turn).success).toBe(true);
  });

  it("done で終わらない返答は不正", () => {
    expect(SampleTurnSchema.safeParse({ request, events: [toolStart, toolEnd] }).success).toBe(
      false,
    );
  });

  it("done が2回ある返答は不正", () => {
    const turn = { request, events: [done, { ...done, atMs: 1000 }] };
    expect(SampleTurnSchema.safeParse(turn).success).toBe(false);
  });

  it("時間が戻るイベントは不正", () => {
    const turn = { request, events: [toolStart, { ...toolEnd, atMs: 50 }, done] };
    expect(SampleTurnSchema.safeParse(turn).success).toBe(false);
  });

  it("開始のないツールの終了は不正", () => {
    expect(SampleTurnSchema.safeParse({ request, events: [toolEnd, done] }).success).toBe(false);
  });
});

describe("data/samples（モックで再生するサンプル）", () => {
  const festivalFiles = readJsonFiles("festivals");
  const conversationFiles = readJsonFiles("conversations");

  it("サンプルの祭りと相談が1件以上ある", () => {
    expect(festivalFiles.length).toBeGreaterThan(0);
    expect(conversationFiles.length).toBeGreaterThan(0);
  });

  it.each(festivalFiles)("祭り %s はスキーマに合う", (name, json) => {
    const festival = FestivalSchema.parse(json);
    expect(`${festival.id}.json`).toBe(name);
  });

  const festivals = new Map<string, Festival>(
    festivalFiles.map(([, json]) => {
      const festival = FestivalSchema.parse(json);
      return [festival.id, festival];
    }),
  );

  describe.each(conversationFiles)("相談 %s", (name, json) => {
    const conversation = SampleConversationSchema.parse(json);
    const events = conversation.turns.flatMap((turn) => turn.events.map((r) => r.event));

    it("ファイル名が id と一致する", () => {
      expect(`${conversation.id}.json`).toBe(name);
    });

    it("出典は例示用のドメインだけ（実在のページを指さない）", () => {
      const urls = JSON.stringify(json).match(/https?:\/\/[^"]+/g) ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(new URL(url).hostname).toBe("example.com");
      }
    });

    it("候補の祭りはサンプルの祭りにあり、日付が開催回と合う", () => {
      for (const event of events) {
        if (event.type !== "tool.end") continue;
        for (const candidate of event.data.candidates ?? []) {
          const festival = festivals.get(candidate.festivalId);
          expect(festival, candidate.festivalId).toBeDefined();
          expect(festival?.occurrences.map((o) => o.date)).toContain(candidate.date);
        }
      }
    });

    it("旅程と再確認が指す祭りと周辺の場所は、サンプルの祭りにある", () => {
      for (const event of events) {
        if (event.type === "festival.verified") {
          expect(festivals.has(event.data.festivalId)).toBe(true);
        }
        if (event.type !== "itinerary.updated") continue;
        const { itinerary } = event.data;
        const main = festivals.get(itinerary.mainFestivalId);
        expect(main, itinerary.mainFestivalId).toBeDefined();
        const spotIds = new Set(main?.nearby.map((spot) => spot.id));
        for (const item of itineraryItems(itinerary)) {
          if (item.festivalId !== undefined) expect(festivals.has(item.festivalId)).toBe(true);
          if (item.spotId !== undefined) expect(spotIds.has(item.spotId), item.spotId).toBe(true);
        }
      }
    });

    it("旅程の差分は、前後の版の予定と食い違わない", () => {
      let previousIds = new Set<string>();
      for (const event of events) {
        if (event.type !== "itinerary.updated") continue;
        const { itinerary, diff } = event.data;
        const ids = new Set(itineraryItems(itinerary).map((item) => item.id));
        expect([...ids].filter((id) => !previousIds.has(id)).sort()).toEqual(
          [...diff.added].sort(),
        );
        expect(diff.removed.map((r) => r.id).sort()).toEqual(
          [...previousIds].filter((id) => !ids.has(id)).sort(),
        );
        for (const id of [...diff.added, ...diff.changed]) {
          const item = itineraryItems(itinerary).find((i) => i.id === id);
          expect(item?.changedInVersion, id).toBe(itinerary.version);
        }
        previousIds = ids;
      }
    });
  });
});

describe("SampleGuideTurnSchema", () => {
  const guideRequest = { message: "雨だったらどうしますか" };
  const guideDone: RecordedGuideEvent = {
    atMs: 900,
    event: {
      type: "guide.done",
      data: { phase: "before", unreadNotices: 0, pendingProposals: 0 },
    },
  };
  const guideToolStart: RecordedGuideEvent = {
    atMs: 100,
    event: {
      type: "guide.tool.start",
      data: { toolCallId: "g-1", tool: "read_trip", bubble: "旅程を見ています" },
    },
  };
  const guideToolEnd: RecordedGuideEvent = {
    atMs: 500,
    event: {
      type: "guide.tool.end",
      data: { toolCallId: "g-1", tool: "read_trip", ok: true, bubble: "見ました" },
    },
  };

  it("ツールの開始と終了のあとに guide.done で終わる返答を受け付ける", () => {
    const turn = {
      request: guideRequest,
      events: [guideToolStart, guideToolEnd, guideDone],
    };
    expect(SampleGuideTurnSchema.safeParse(turn).success).toBe(true);
  });

  it("guide.done で終わらない返答と、開始のないツールの終了は不正", () => {
    expect(
      SampleGuideTurnSchema.safeParse({
        request: guideRequest,
        events: [guideToolStart, guideToolEnd],
      }).success,
    ).toBe(false);
    expect(
      SampleGuideTurnSchema.safeParse({ request: guideRequest, events: [guideToolEnd, guideDone] })
        .success,
    ).toBe(false);
  });

  it("現在地は記録に残せない", () => {
    expect(
      SampleGuideTurnSchema.safeParse({
        request: { ...guideRequest, location: { lat: 35.12, lng: 136.08 } },
        events: [guideDone],
      }).success,
    ).toBe(false);
  });
});

describe("SamplePatrolSchema", () => {
  it("報告は同じ見回りのものにする", () => {
    const patrol = {
      request: fictionalPatrolRequest(),
      report: fictionalPatrolReport(),
      changes: [],
    };
    expect(SamplePatrolSchema.safeParse(patrol).success).toBe(true);
    expect(
      SamplePatrolSchema.safeParse({ ...patrol, report: { patrolId: "other", findings: [] } })
        .success,
    ).toBe(false);
  });
});

describe("data/samples/guide（ガイドの相談と見回りのサンプル）", () => {
  const guideFiles = readJsonFiles("guide");
  const festivals = new Map<string, Festival>(
    readJsonFiles("festivals").map(([, json]) => {
      const festival = FestivalSchema.parse(json);
      return [festival.id, festival];
    }),
  );
  const conversations = new Map(
    readJsonFiles("conversations").map(([, json]) => {
      const conversation = SampleConversationSchema.parse(json);
      return [conversation.id, conversation];
    }),
  );

  /** もとの相談の最後の旅程 */
  function baseItinerary(conversationId: string): Itinerary {
    const updates = (conversations.get(conversationId)?.turns ?? [])
      .flatMap((turn) => turn.events.map((recorded) => recorded.event))
      .flatMap((event) => (event.type === "itinerary.updated" ? [event.data.itinerary] : []));
    const last = updates.at(-1);
    if (last === undefined) throw new Error(`${conversationId} に旅程がありません`);
    return last;
  }

  it("サンプルが1件以上ある", () => {
    expect(guideFiles.length).toBeGreaterThan(0);
  });

  describe.each(guideFiles)("サンプル %s", (name, json) => {
    const sample = SampleGuideSchema.parse(json);
    const base = baseItinerary(sample.conversation);
    const events = sample.turns.flatMap((turn) => turn.events.map((recorded) => recorded.event));

    it("ファイル名が id と一致する", () => {
      expect(`${sample.id}.json`).toBe(name);
    });

    it("出典は例示用のドメインだけ（実在のページを指さない）", () => {
      const urls = JSON.stringify(json).match(/https?:\/\/[^"]+/g) ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(new URL(url).hostname).toBe("example.com");
      }
    });

    it("旅はもとの相談の旅程で、見回りは旅の翌日に止まる", () => {
      expect(sample.watch.tripId).toBe(base.id);
      const dayAfter = new Date(`${base.days.at(-1)?.date}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      expect(sample.watch.endsOn).toBe(dayAfter.toISOString().slice(0, 10));
      for (const event of events) {
        if (event.type === "guide.done") {
          expect(event.data.phase).toBe(tripPhase(base, sample.today));
        }
      }
    });

    it("見回りに渡す内容にも受け取る内容にも、旅と利用者の情報が入らない", () => {
      const patrol = JSON.stringify(sample.patrol);
      for (const secret of [base.id, base.origin, base.title, sample.watch.tripId]) {
        expect(patrol).not.toContain(secret);
      }
      expect(patrol).not.toContain("tripId");
    });

    it("見回りの対象は祭りのデータにあり、開催日が合う", () => {
      for (const target of sample.patrol.request.targets) {
        const festival = festivals.get(target.festivalId);
        expect(festival?.name.ja).toBe(target.festivalName);
        expect(festival?.occurrences.map((o) => o.date)).toContain(target.date);
      }
    });

    it("開催の変更の変更前は、祭りのデータの値と合う", () => {
      for (const { content } of sample.patrol.changes) {
        if (content.kind !== "schedule_change") continue;
        const occurrence = festivals
          .get(content.festivalId)
          ?.occurrences.find((o) => o.date === content.date);
        for (const change of content.changes) {
          expect(change.before).toBe(occurrence?.[change.field]);
        }
      }
    });

    it("ページの中の指示は、報告・変化・通知・提案・返答に残らない", () => {
      const lines = sample.patrol.request.targets.flatMap((target) =>
        target.pages.flatMap((page) => page.changedLines),
      );
      const instruction = lines.find((line) => line.includes("AI"));
      expect(instruction).toBeDefined();
      const passedOn = JSON.stringify([
        sample.patrol.report,
        sample.patrol.changes,
        sample.notices,
        sample.proposals,
        sample.turns,
      ]);
      expect(passedOn).not.toContain(instruction);
    });

    it("通知は検問を通った変化から作る", () => {
      for (const notice of sample.notices) {
        const change = sample.patrol.changes.find((c) => c.fingerprint === notice.fingerprint);
        expect(change, notice.id).toBeDefined();
        expect(notice.content).toEqual(change?.content);
        expect(notice.sources).toEqual(change?.sources);
        expect(notice.checkedAt).toBe(change?.checkedAt);
        expect(notice.tripId).toBe(base.id);
        const itemIds = itineraryItems(base).map((item) => item.id);
        for (const id of notice.affectedItemIds) expect(itemIds).toContain(id);
      }
    });

    it("提案はもとの旅程の次の版で、差分が実際の違いと合い、通知とつながる", () => {
      expect(sample.proposals.length).toBeGreaterThan(0);
      const baseItems = new Map(itineraryItems(base).map((item) => [item.id, item]));
      for (const proposal of sample.proposals) {
        expect(proposal.status).toBe("pending");
        expect(proposal.baseVersion).toBe(base.version);
        const changed = itineraryItems(proposal.itinerary)
          .filter((item) => {
            const before = baseItems.get(item.id);
            return (
              before !== undefined &&
              JSON.stringify({ ...before, changedInVersion: 0 }) !==
                JSON.stringify({ ...item, changedInVersion: 0 })
            );
          })
          .map((item) => item.id);
        expect([...proposal.diff.changed].sort()).toEqual(changed.sort());
        for (const id of proposal.diff.changed) {
          const item = itineraryItems(proposal.itinerary).find((i) => i.id === id);
          expect(item?.changedInVersion, id).toBe(proposal.itinerary.version);
        }
        for (const noticeId of proposal.noticeIds) {
          const notice = sample.notices.find((n) => n.id === noticeId);
          expect(notice?.proposalId).toBe(proposal.id);
        }
      }
    });

    it("返答に出す通知と提案は、サンプルの一覧にあるもの", () => {
      for (const event of events) {
        if (event.type === "guide.notice") {
          expect(sample.notices).toContainEqual(event.data.notice);
        }
        if (event.type === "guide.proposal") {
          expect(sample.proposals).toContainEqual(event.data.proposal);
        }
      }
    });

    it("緊急の相談では、連絡先を返答の文より先に出す", () => {
      const emergencyTurns = sample.turns.filter((turn) =>
        turn.events.some(({ event }) => event.type === "guide.emergency"),
      );
      expect(emergencyTurns.length).toBeGreaterThan(0);
      for (const turn of emergencyTurns) {
        expect(turn.events[0]?.event.type).toBe("guide.emergency");
      }
    });
  });
});
