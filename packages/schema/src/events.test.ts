import { describe, expect, it } from "vitest";
import {
  decodeSseEvent,
  encodeSseEvent,
  type FestivalCandidate,
  SSE_EVENT_TYPES,
  type SseEvent,
  SseEventSchema,
} from "./events";
import { DEFAULT_PREFERENCES } from "./preferences";
import { fictionalItinerary, fictionalSource } from "./testing";

function candidate(overrides: Partial<FestivalCandidate> = {}): FestivalCandidate {
  return {
    festivalId: "suzunari-toro",
    name: "鈴鳴灯籠まつり",
    date: "2026-08-16",
    start: "18:30",
    end: "21:00",
    venueName: "鈴鳴川の河原",
    place: "滋賀県鈴鳴町",
    daysFromWish: 0,
    confidence: "official",
    confirmed: true,
    highlight: "川面に浮かぶ千の灯籠",
    source: fictionalSource("2026"),
    ...overrides,
  };
}

/** 8種類のイベントを1つずつ */
function exampleEvents(): SseEvent[] {
  return [
    {
      type: "staff.start",
      data: { staff: "researcher", task: "find_festivals", bubble: "調べてきますね" },
    },
    {
      type: "tool.start",
      data: {
        toolCallId: "call-1",
        tool: "search_festivals",
        staff: "researcher",
        bubble: "8月16日に行ける祭りを探しています",
      },
    },
    {
      type: "tool.end",
      data: {
        toolCallId: "call-1",
        tool: "search_festivals",
        staff: "researcher",
        ok: true,
        bubble: "1件見つかりました",
        count: 1,
        candidates: [candidate()],
      },
    },
    {
      type: "itinerary.updated",
      data: {
        itinerary: fictionalItinerary(),
        diff: {
          fromVersion: 0,
          toVersion: 1,
          added: ["go", "craft-hall", "festival"],
          changed: [],
          removed: [],
        },
      },
    },
    {
      type: "festival.verified",
      data: {
        festivalId: "suzunari-toro",
        result: "as_planned",
        checkedAt: "2026-08-15T09:00:00+09:00",
        sources: [fictionalSource("2026")],
      },
    },
    { type: "message.delta", data: { messageId: "m-1", text: "鈴鳴灯籠まつりはいかがですか。" } },
    {
      type: "error",
      data: {
        code: "timeout",
        message: "時間がかかっています。もう一度送ってください。",
        retryable: true,
      },
    },
    {
      type: "done",
      data: {
        stage: "candidates",
        conditions: { when: { kind: "date", date: "2026-08-16" }, origin: "みなと中央駅" },
        preferences: { ...DEFAULT_PREFERENCES },
      },
    },
  ];
}

describe("SseEventSchema", () => {
  it.each(exampleEvents().map((event) => [event.type, event] as const))(
    "%s を受け付ける",
    (_, event) => {
      expect(SseEventSchema.safeParse(event).success).toBe(true);
    },
  );

  it("SSE_EVENT_TYPES は、スキーマにあるイベントの種類と一致する", () => {
    const types = SseEventSchema.options.map((option) => option.shape.type.value);
    expect([...SSE_EVENT_TYPES].sort()).toEqual([...types].sort());
  });

  it("知らない種類のイベントは受け付けない", () => {
    expect(SseEventSchema.safeParse({ type: "staff.dance", data: {} }).success).toBe(false);
  });

  it("候補は search_festivals の結果にだけ付く", () => {
    const event = {
      type: "tool.end",
      data: {
        toolCallId: "call-2",
        tool: "get_weather",
        staff: "planner",
        ok: true,
        bubble: "天気を確かめました",
        count: null,
        candidates: [candidate()],
      },
    };
    expect(SseEventSchema.safeParse(event).success).toBe(false);
  });

  it("候補は3件まで", () => {
    const event = exampleEvents()[2] as Extract<SseEvent, { type: "tool.end" }>;
    event.data.candidates = [candidate(), candidate(), candidate(), candidate()];
    expect(SseEventSchema.safeParse(event).success).toBe(false);
  });

  it("予定どおりの再確認には出典が必要", () => {
    const event = exampleEvents()[4] as Extract<SseEvent, { type: "festival.verified" }>;
    event.data.sources = [];
    expect(SseEventSchema.safeParse(event).success).toBe(false);
  });

  it("候補を出す前の確かめは、祭りと日付を添えて送れる。候補にも結果を付けられる", () => {
    const event = exampleEvents()[4] as Extract<SseEvent, { type: "festival.verified" }>;
    event.data = { ...event.data, scope: "candidate", date: "2026-08-16" };
    expect(SseEventSchema.safeParse(event).success).toBe(true);
    event.data = { ...event.data, scope: "draft" as never };
    expect(SseEventSchema.safeParse(event).success).toBe(false);

    const withCheck = exampleEvents()[2] as Extract<SseEvent, { type: "tool.end" }>;
    withCheck.data.candidates = [
      { ...candidate(), check: { result: "not_found", checkedAt: "2026-08-03T10:00:00+09:00" } },
    ];
    expect(SseEventSchema.safeParse(withCheck).success).toBe(true);
  });

  it("旅程の更新では、差分の版と旅程の版がそろう", () => {
    const event = exampleEvents()[3] as Extract<SseEvent, { type: "itinerary.updated" }>;
    event.data.diff = { ...event.data.diff, fromVersion: 1, toVersion: 2 };
    expect(SseEventSchema.safeParse(event).success).toBe(false);
  });

  it("調べ直しの頼みは、ほかのスタッフに送る。足りないものは決まった種類だけ", () => {
    const redo = {
      type: "staff.redo",
      data: {
        kind: "request",
        from: "planner",
        to: "scout",
        subject: "lunch",
        bubble: "昼ごはんの店がまだです。もう一度探してもらえますか",
      },
    };
    expect(SseEventSchema.safeParse(redo).success).toBe(true);
    expect(
      SseEventSchema.safeParse({ ...redo, data: { ...redo.data, to: "planner" } }).success,
    ).toBe(false);
    expect(
      SseEventSchema.safeParse({ ...redo, data: { ...redo.data, subject: "dessert" } }).success,
    ).toBe(false);
  });

  it("ツールの後に、くわしい文を付けられる（空の文は送らない）", () => {
    const end = {
      type: "tool.end",
      data: {
        toolCallId: "c-1",
        tool: "search_lodging",
        staff: "planner",
        ok: true,
        bubble: "宿を2軒見つけました",
        detail: "8月15日に泊まれる宿を2軒見つけました",
        count: 2,
      },
    };
    expect(SseEventSchema.safeParse(end).success).toBe(true);
    expect(SseEventSchema.safeParse({ ...end, data: { ...end.data, detail: "" } }).success).toBe(
      false,
    );
  });

  it("空の返答の続きは送らない", () => {
    const event = { type: "message.delta", data: { messageId: "m-1", text: "" } };
    expect(SseEventSchema.safeParse(event).success).toBe(false);
  });
});

describe("encodeSseEvent / decodeSseEvent", () => {
  it.each(exampleEvents().map((event) => [event.type, event] as const))(
    "%s を SSE の1件にして戻せる",
    (type, event) => {
      const message = encodeSseEvent(event);
      expect(message.event).toBe(type);
      expect(decodeSseEvent(message)).toEqual(event);
    },
  );

  it("不正なイベントは送らない", () => {
    const invalid = { type: "message.delta", data: { messageId: "m-1", text: "" } } as SseEvent;
    expect(() => encodeSseEvent(invalid)).toThrow();
  });

  it("種類と中身が合わないものは受け取らない", () => {
    expect(() => decodeSseEvent({ event: "done", data: JSON.stringify({ text: "x" }) })).toThrow();
  });

  it("JSON として読めないものは受け取らない", () => {
    expect(() => decodeSseEvent({ event: "message.delta", data: "{" })).toThrow();
  });
});
