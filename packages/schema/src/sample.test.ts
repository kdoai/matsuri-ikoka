import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Festival, FestivalSchema } from "./festival";
import { DEFAULT_PREFERENCES } from "./preferences";
import { type RecordedEvent, SampleConversationSchema, SampleTurnSchema } from "./sample";

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
        for (const item of itinerary.items) {
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
        const ids = new Set(itinerary.items.map((item) => item.id));
        expect([...ids].filter((id) => !previousIds.has(id)).sort()).toEqual(
          [...diff.added].sort(),
        );
        expect(diff.removed.map((r) => r.id).sort()).toEqual(
          [...previousIds].filter((id) => !ids.has(id)).sort(),
        );
        for (const id of [...diff.added, ...diff.changed]) {
          const item = itinerary.items.find((i) => i.id === id);
          expect(item?.changedInVersion, id).toBe(itinerary.version);
        }
        previousIds = ids;
      }
    });
  });
});
