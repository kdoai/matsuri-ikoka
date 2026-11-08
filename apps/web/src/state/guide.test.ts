import {
  decodeGuideSseEvent,
  encodeGuideSseEvent,
  type GuideNotice,
  type GuideStateResponse,
  type NoticeContent,
} from "@matsuri-ikoka/schema";
import { fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import {
  advanceReport,
  applyGuideEvent,
  applyGuideState,
  beginGuideTurn,
  endGuideTurn,
  guideLine,
  INITIAL_GUIDE,
  litStalls,
  markRead,
  noticesOfStall,
  reportedNotice,
} from "./guide";

function notice(id: string, content: NoticeContent): GuideNotice {
  return {
    id,
    tripId: "trip-example",
    fingerprint: "a".repeat(16),
    content,
    sources: [{ ...fictionalSource("notice"), title: undefined }].map(
      ({ title: _, ...source }) => source,
    ),
    checkedAt: "2026-08-10T06:00:00+09:00",
    summary: `${id} の知らせ`,
    affectedItemIds: [],
    proposalId: null,
    createdAt: "2026-08-10T06:01:00+09:00",
    readAt: null,
  };
}

const weather = notice("n-weather", {
  kind: "weather",
  date: "2026-08-16",
  condition: "rain",
  precipitationPercent: 80,
});
const cancelled = notice("n-cancel", {
  kind: "cancellation",
  festivalId: "example-festival",
  date: "2026-08-16",
});
const traffic = notice("n-traffic", {
  kind: "announcement",
  festivalId: "example-festival",
  date: "2026-08-16",
  topic: "traffic",
});

function response(notices: GuideNotice[]): GuideStateResponse {
  return {
    tripId: "trip-example",
    version: 1,
    phase: "before",
    watch: null,
    watchAvailable: true,
    notices,
    proposals: [],
    memo: [],
  };
}

describe("提灯", () => {
  it("未読の通知がある屋台だけが灯り、通知の中身で屋台が決まる", () => {
    const guide = { notices: [weather, cancelled, traffic] };
    expect(litStalls(guide)).toEqual(["access", "weather", "headquarters"]);
    expect(noticesOfStall(guide, "weather")).toEqual([weather]);
  });

  it("読むと消える", () => {
    const guide = markRead(
      { ...INITIAL_GUIDE, notices: [weather] },
      ["n-weather"],
      "2026-08-11T00:00:00Z",
    );
    expect(litStalls(guide)).toEqual([]);
  });
});

describe("報告", () => {
  it("未読の通知が届くと、ガイドが旅人へ駆け寄って報告する。同じ通知は2度報告しない", () => {
    const guide = applyGuideState(INITIAL_GUIDE, response([weather]));
    expect(guide.availability).toBe("ready");
    expect(guide.spot).toBe("player");
    expect(guide.dialogueOpen).toBe(true);
    expect(reportedNotice(guide)?.id).toBe("n-weather");
    expect(guideLine(guide)).toMatchObject({ kind: "report" });

    const later = advanceReport({ ...guide, report: null, spot: "home", dialogueOpen: false });
    expect(later.report).toBeNull();
    expect(later.spot).toBe("home");
  });

  it("返答に届いた通知は提灯だけを灯し、読んでいる返事を隠さない。次に話しかけたときに報告する", () => {
    const started = beginGuideTurn(
      { ...INITIAL_GUIDE, availability: "ready" },
      "変わったことは",
      false,
    );
    const arrived = applyGuideEvent(started, { type: "guide.notice", data: { notice: weather } });
    expect(arrived.report).toBeNull();
    expect(litStalls(arrived)).toEqual(["weather"]);
    const answered = applyGuideEvent(arrived, {
      type: "message.delta",
      data: { messageId: "m", text: "雨の予報です。" },
    });
    const done = applyGuideEvent(answered, {
      type: "guide.done",
      data: { phase: "before", unreadNotices: 1, pendingProposals: 0 },
    });
    expect(done.report).toBeNull();
    expect(guideLine(done)).toMatchObject({ kind: "guide", text: "雨の予報です。" });
    expect(advanceReport(done).report).toBe("n-weather");
  });

  it("報告の途中で発言すると、報告を閉じて返事を見せる", () => {
    const reporting = applyGuideState(INITIAL_GUIDE, response([weather]));
    const asked = beginGuideTurn(reporting, "傘は要りますか", false);
    expect(asked.report).toBeNull();
    expect(guideLine(asked)).toEqual({ kind: "waiting" });
  });

  it("話している最中に読み直しても、報告を重ねない", () => {
    const talking = {
      ...beginGuideTurn({ ...INITIAL_GUIDE, availability: "ready" as const }, "こんにちは", false),
      streaming: false,
    };
    const reloaded = applyGuideState(talking, response([weather]));
    expect(reloaded.report).toBeNull();
    expect(litStalls(reloaded)).toEqual(["weather"]);
  });

  it("屋台を開いている間は、次の報告を重ねない", () => {
    const open = { ...INITIAL_GUIDE, notices: [weather], openStall: "food" as const };
    expect(advanceReport(open).report).toBeNull();
    expect(advanceReport({ ...open, openStall: null }).report).toBe("n-weather");
  });

  it("読み直しても、手元で読んだ通知は未読に戻らない", () => {
    const read = markRead(
      { ...INITIAL_GUIDE, notices: [weather] },
      ["n-weather"],
      "2026-08-11T00:00:00+09:00",
    );
    const reloaded = applyGuideState(read, response([weather]));
    expect(litStalls(reloaded)).toEqual([]);
    expect(reloaded.report).toBeNull();
  });
});

describe("発言と返答", () => {
  const ready = { ...INITIAL_GUIDE, availability: "ready" as const };

  it("文の続きを1つの発言にまとめ、ツールの吹き出しを出す", () => {
    let guide = beginGuideTurn(ready, "雨のときは", false);
    expect(guideLine(guide)).toEqual({ kind: "waiting" });
    guide = applyGuideEvent(guide, {
      type: "guide.tool.start",
      data: { toolCallId: "c1", tool: "get_weather", bubble: "天気を調べています" },
    });
    expect(guideLine(guide)).toEqual({
      kind: "tool",
      tool: "get_weather",
      bubble: "天気を調べています",
    });
    guide = applyGuideEvent(guide, {
      type: "guide.tool.end",
      data: { toolCallId: "c1", tool: "get_weather", ok: true, bubble: "調べました" },
    });
    for (const text of ["雨なら", "屋内へ。"]) {
      guide = applyGuideEvent(guide, { type: "message.delta", data: { messageId: "m", text } });
    }
    expect(guideLine(guide)).toMatchObject({
      kind: "guide",
      text: "雨なら屋内へ。",
      streaming: true,
    });
    guide = applyGuideEvent(guide, {
      type: "guide.done",
      data: { phase: "during", unreadNotices: 0, pendingProposals: 0 },
    });
    expect(guide.streaming).toBe(false);
    expect(guide.phase).toBe("during");
    expect(guideLine(guide)).toMatchObject({ kind: "guide", streaming: false });
  });

  it("送り直すときは、自分の発言を重ねず、前のエラーを消す", () => {
    let guide = beginGuideTurn(ready, "持ち物は", false);
    guide = endGuideTurn(guide, { code: "connection_lost", message: null, retryable: true });
    expect(guideLine(guide)).toMatchObject({ kind: "error", retryable: true });
    guide = beginGuideTurn(guide, "持ち物は", true);
    expect(guide.entries.map((entry) => entry.kind)).toEqual(["user"]);
    expect(guide.streaming).toBe(true);
  });

  it("手帳に残したことも、会話の記録で読める", () => {
    const guide = applyGuideEvent(beginGuideTurn(ready, "ゆっくり歩きます", false), {
      type: "guide.memo",
      data: {
        item: {
          id: "memo-1",
          kind: "pace",
          text: "ゆっくり歩く",
          createdAt: "2026-08-10T06:00:00+09:00",
          updatedAt: "2026-08-10T06:00:00+09:00",
        },
      },
    });
    expect(guide.memo).toHaveLength(1);
    expect(guide.entries.at(-1)).toMatchObject({ kind: "memo", text: "ゆっくり歩く" });
  });

  it("返事の途中で失敗しても、届いていた文を隠さない", () => {
    let guide = beginGuideTurn(ready, "持ち物は", false);
    guide = applyGuideEvent(guide, {
      type: "message.delta",
      data: { messageId: "m", text: "雨具があると安心です。" },
    });
    guide = applyGuideEvent(guide, {
      type: "error",
      data: { code: "upstream_unavailable", message: "混み合っています", retryable: true },
    });
    expect(guideLine(guide)).toMatchObject({
      kind: "error",
      said: "雨具があると安心です。",
      code: "upstream_unavailable",
    });
  });

  it("相談や旅が切れた知らせは、専用の案内にして、話せない状態にする", () => {
    const guide = applyGuideEvent(beginGuideTurn(ready, "持ち物は", false), {
      type: "error",
      data: { code: "bad_request", message: "相談が見つかりません。", retryable: false },
    });
    expect(guide.availability).toBe("unavailable");
    expect(guideLine(guide)).toMatchObject({ kind: "error", code: "guide_gone", message: null });
  });

  it("同じ発言の失敗を2度重ねない", () => {
    const failed = applyGuideEvent(beginGuideTurn(ready, "持ち物は", false), {
      type: "error",
      data: { code: "internal", message: "失敗しました", retryable: true },
    });
    const ended = endGuideTurn(failed, { code: "connection_lost", message: null, retryable: true });
    expect(ended.entries.filter((entry) => entry.kind === "error")).toHaveLength(1);
  });

  it("話せない環境では、話せないことを出す", () => {
    expect(guideLine({ ...INITIAL_GUIDE, availability: "unavailable" })).toEqual({
      kind: "unavailable",
    });
  });

  it("SSE の形のとおりに読める", () => {
    const event = decodeGuideSseEvent(
      encodeGuideSseEvent({ type: "message.delta", data: { messageId: "m", text: "はい" } }),
    );
    const guide = applyGuideEvent(beginGuideTurn(ready, "はい？", false), event);
    expect(guideLine(guide)).toMatchObject({ kind: "guide", text: "はい" });
  });
});
