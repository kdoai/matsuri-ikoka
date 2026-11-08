import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_MESSAGE_LENGTH } from "./api";
import { SSE_EVENT_TYPES, SseEventSchema } from "./events";
import {
  base64ByteLength,
  CheckedChangeSchema,
  CheckedSourceSchema,
  DecideProposalRequestSchema,
  DecideProposalResponseSchema,
  decodeGuideSseEvent,
  encodeGuideSseEvent,
  GUIDE_PHOTO_TYPES,
  GUIDE_SSE_EVENT_TYPES,
  type GUIDE_STALLS,
  GuideChatRequestSchema,
  GuideMemoItemSchema,
  GuideNoticeSchema,
  GuidePhotoSchema,
  GuideProposalSchema,
  GuideResumeSummarySchema,
  type GuideSseEvent,
  GuideSseEventSchema,
  GuideStateResponseSchema,
  MAX_GUIDE_PHOTO_BYTES,
  MAX_PENDING_PROPOSALS,
  type NoticeContent,
  NoticeContentSchema,
  noticeStall,
  PatrolIdSchema,
  PatrolPageSchema,
  PatrolReportSchema,
  PatrolRequestSchema,
  PatrolTargetSchema,
  roundLocation,
  TripWatchSchema,
  tripPhase,
} from "./guide";
import {
  fictionalCheckedChange,
  fictionalItinerary,
  fictionalMemoItem,
  fictionalNotice,
  fictionalPatrolReport,
  fictionalPatrolRequest,
  fictionalPhoto,
  fictionalProposal,
  fictionalSource,
  fictionalTripWatch,
} from "./testing";

/** 利用者や旅を指す項目の名前。見回り係へ渡すものと、見回り係から受け取るものに持たせない */
const USER_DATA_KEYS = [
  "uid",
  "userId",
  "owner",
  "email",
  "tripId",
  "itineraryId",
  "sessionId",
  "origin",
  "party",
  "location",
  "message",
  "memo",
];

/** JSON Schema の中の、すべての項目の名前を集める */
function propertyNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(propertyNames);
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) =>
    key === "properties" && typeof value === "object" && value !== null
      ? [...Object.keys(value), ...propertyNames(Object.values(value))]
      : propertyNames(value),
  );
}

describe("tripPhase", () => {
  const trip = { days: [{ date: "2026-08-15" }, { date: "2026-08-16" }] };

  it.each([
    ["2026-08-14", "before"],
    ["2026-08-15", "during"],
    ["2026-08-16", "during"],
    ["2026-08-17", "after"],
  ])("%s は %s", (today, phase) => {
    expect(tripPhase(trip, today)).toBe(phase);
  });
});

describe("TripWatchSchema", () => {
  it("架空の見回りの依頼を受け付ける", () => {
    expect(TripWatchSchema.safeParse(fictionalTripWatch()).success).toBe(true);
  });

  it("止めた時刻は、止めたときだけ持つ", () => {
    expect(
      TripWatchSchema.safeParse({
        ...fictionalTripWatch(),
        stoppedAt: "2026-08-11T10:00:00+09:00",
      }).success,
    ).toBe(false);
    expect(TripWatchSchema.safeParse({ ...fictionalTripWatch(), status: "stopped" }).success).toBe(
      false,
    );
    expect(
      TripWatchSchema.safeParse({
        ...fictionalTripWatch(),
        status: "ended",
        stoppedAt: "2026-08-17T00:00:00+09:00",
      }).success,
    ).toBe(true);
  });
});

describe("見回り係へ渡すもの", () => {
  it("架空の依頼を受け付ける", () => {
    expect(PatrolRequestSchema.safeParse(fictionalPatrolRequest()).success).toBe(true);
  });

  it("どの階層にも、利用者や旅を指す項目を定義していない", () => {
    const names = propertyNames(z.toJSONSchema(PatrolRequestSchema));
    expect(names).toContain("festivalId");
    expect(names.filter((name) => USER_DATA_KEYS.includes(name))).toEqual([]);
  });

  it.each(USER_DATA_KEYS)("%s を足した依頼は、どの階層でも受け付けない", (key) => {
    const request = fictionalPatrolRequest();
    const target = request.targets[0] as (typeof request.targets)[number];
    const page = target.pages[0] as (typeof target.pages)[number];
    const leaked = { [key]: "someone" };

    expect(PatrolRequestSchema.safeParse({ ...request, ...leaked }).success).toBe(false);
    expect(PatrolTargetSchema.safeParse({ ...target, ...leaked }).success).toBe(false);
    expect(PatrolPageSchema.safeParse({ ...page, ...leaked }).success).toBe(false);
  });

  it("同じ祭りと開催日は1つにまとめる（同じ祭りを何度も調べない）", () => {
    const request = fictionalPatrolRequest();
    const target = request.targets[0] as (typeof request.targets)[number];
    expect(PatrolRequestSchema.safeParse({ ...request, targets: [target, target] }).success).toBe(
      false,
    );
    expect(
      PatrolRequestSchema.safeParse({
        ...request,
        targets: [target, { ...target, date: "2026-08-17" }],
      }).success,
    ).toBe(true);
  });

  it("変わった行は changed のページにだけ書く", () => {
    const page = { url: "https://example.com/suzunari/2026" };
    expect(
      PatrolPageSchema.safeParse({ ...page, reason: "changed", changedLines: [] }).success,
    ).toBe(false);
    expect(
      PatrolPageSchema.safeParse({ ...page, reason: "unreadable", changedLines: [] }).success,
    ).toBe(true);
    expect(
      PatrolPageSchema.safeParse({ ...page, reason: "unreadable", changedLines: ["行"] }).success,
    ).toBe(false);
  });

  it("http と https 以外の URL は受け付けない", () => {
    expect(
      PatrolPageSchema.safeParse({
        url: "file:///etc/passwd",
        reason: "unreadable",
        changedLines: [],
      }).success,
    ).toBe(false);
  });

  it.each([
    "patrol-suzunari-sample",
    "trip-suzunari",
    "uid-0123456789abcdef",
    "patrol-0123456789ABCDEF",
    "patrol-0123456789abcde",
    "patrol-0123456789abcdef0",
    "patrol-0123456789abcdef\n",
    "",
  ])("見回りの ID は決まった乱数の形だけで、依頼でも報告でも断る（%j）", (patrolId) => {
    expect(PatrolIdSchema.safeParse(patrolId).success).toBe(false);
    expect(PatrolRequestSchema.safeParse({ ...fictionalPatrolRequest(), patrolId }).success).toBe(
      false,
    );
    expect(PatrolReportSchema.safeParse({ ...fictionalPatrolReport(), patrolId }).success).toBe(
      false,
    );
  });
});

describe("見回り係から受け取るもの", () => {
  it("架空の報告を受け付ける", () => {
    expect(PatrolReportSchema.safeParse(fictionalPatrolReport()).success).toBe(true);
  });

  it("どの階層にも、利用者や旅を指す項目を定義していない", () => {
    const names = propertyNames(z.toJSONSchema(PatrolReportSchema));
    expect(names.filter((name) => USER_DATA_KEYS.includes(name))).toEqual([]);
  });

  it.each(["note", "instructions", "checkedAt", "confidence"])(
    "決まった項目のほかは受け取らない（%s）",
    (key) => {
      const report = fictionalPatrolReport();
      const finding = report.findings[0] as (typeof report.findings)[number];
      expect(
        PatrolReportSchema.safeParse({ ...report, findings: [{ ...finding, [key]: "x" }] }).success,
      ).toBe(false);
    },
  );
});

describe("検問を通った変化", () => {
  it("架空の変化を受け付ける", () => {
    expect(CheckedChangeSchema.safeParse(fictionalCheckedChange()).success).toBe(true);
  });

  it("出典がなければ通らない", () => {
    expect(
      CheckedChangeSchema.safeParse({ ...fictionalCheckedChange(), sources: [] }).success,
    ).toBe(false);
  });

  it("調べた時刻がなければ通らない", () => {
    const { checkedAt: _, ...withoutTime } = fictionalCheckedChange();
    expect(CheckedChangeSchema.safeParse(withoutTime).success).toBe(false);
  });

  it("ページの文章を運ぶ項目がない（題名も通らない）", () => {
    const names = propertyNames(z.toJSONSchema(CheckedChangeSchema));
    for (const key of ["title", "quote", "text", "note", "dateText", "changedLines"]) {
      expect(names).not.toContain(key);
    }
    expect(
      CheckedSourceSchema.safeParse({ ...fictionalSource("2026"), title: "ページの題名" }).success,
    ).toBe(false);
    expect(
      CheckedChangeSchema.safeParse({ ...fictionalCheckedChange(), note: "ページの文" }).success,
    ).toBe(false);
  });

  it("推定の出典は使えない", () => {
    expect(
      CheckedChangeSchema.safeParse({
        ...fictionalCheckedChange(),
        sources: [fictionalSource("2026", "inferred")],
      }).success,
    ).toBe(false);
  });

  it("中止と日程の変更は、1つの情報源だけでは知らせない。お知らせは知らせる", () => {
    const single = [fictionalSource("2026", "single")];
    const change = fictionalCheckedChange();
    expect(CheckedChangeSchema.safeParse({ ...change, sources: single }).success).toBe(false);
    expect(
      CheckedChangeSchema.safeParse({
        ...change,
        content: { kind: "cancellation", festivalId: "suzunari-toro", date: "2026-08-16" },
        sources: single,
      }).success,
    ).toBe(false);
    expect(
      CheckedChangeSchema.safeParse({
        ...change,
        content: {
          kind: "announcement",
          festivalId: "suzunari-toro",
          date: "2026-08-16",
          topic: "traffic",
        },
        sources: single,
      }).success,
    ).toBe(true);
  });

  it("開催の変更は、変わった項目だけを書く。順延で新しい日が分からなくてもよい", () => {
    const content = { kind: "schedule_change", festivalId: "suzunari-toro", date: "2026-08-16" };
    expect(
      NoticeContentSchema.safeParse({
        ...content,
        changes: [{ field: "start", before: "18:30", after: "18:30" }],
      }).success,
    ).toBe(false);
    expect(NoticeContentSchema.safeParse({ ...content, changes: [] }).success).toBe(false);
    expect(
      NoticeContentSchema.safeParse({
        ...content,
        changes: [{ field: "date", before: "2026-08-16", after: null }],
      }).success,
    ).toBe(true);
  });

  it("開催の変更は、同じ項目を重ねて書けない", () => {
    const content = { kind: "schedule_change", festivalId: "suzunari-toro", date: "2026-08-16" };
    expect(
      NoticeContentSchema.safeParse({
        ...content,
        changes: [
          { field: "start", before: "18:30", after: "19:30" },
          { field: "start", before: "18:30", after: "20:00" },
        ],
      }).success,
    ).toBe(false);
    expect(
      NoticeContentSchema.safeParse({
        ...content,
        changes: [
          { field: "date", before: "2026-08-16", after: "2026-08-17" },
          { field: "start", before: "18:30", after: "19:30" },
          { field: "end", before: "21:00", after: "21:30" },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("GuideNoticeSchema", () => {
  it("架空の通知を受け付ける", () => {
    expect(GuideNoticeSchema.safeParse(fictionalNotice()).success).toBe(true);
  });

  it("出典と調べた時刻は必須", () => {
    const { checkedAt: _, ...withoutTime } = fictionalNotice();
    expect(GuideNoticeSchema.safeParse(withoutTime).success).toBe(false);
    expect(GuideNoticeSchema.safeParse({ ...fictionalNotice(), sources: [] }).success).toBe(false);
  });

  it("どの種類の通知にも出典と調べた時刻が要る", () => {
    const contents: NoticeContent[] = [
      fictionalCheckedChange().content,
      { kind: "cancellation", festivalId: "suzunari-toro", date: "2026-08-16" },
      { kind: "announcement", festivalId: "suzunari-toro", date: "2026-08-16", topic: "other" },
      {
        kind: "availability",
        lodgingName: "川べりの宿 すずなり",
        checkIn: "2026-08-15",
        checkOut: "2026-08-16",
        available: true,
        nightlyTotalYen: 24000,
        bookingUrl: "https://example.com/lodging/suzunari-kawabe-inn",
      },
      { kind: "weather", date: "2026-08-16", condition: "rain", precipitationPercent: 80 },
    ];
    for (const content of contents) {
      expect(GuideNoticeSchema.safeParse({ ...fictionalNotice(), content }).success).toBe(true);
      expect(
        GuideNoticeSchema.safeParse({ ...fictionalNotice(), content, sources: [] }).success,
      ).toBe(false);
    }
  });
});

describe("noticeStall", () => {
  it.each<[NoticeContent, (typeof GUIDE_STALLS)[number]]>([
    [fictionalCheckedChange().content, "headquarters"],
    [{ kind: "cancellation", festivalId: "suzunari-toro", date: "2026-08-16" }, "headquarters"],
    [
      { kind: "announcement", festivalId: "suzunari-toro", date: "2026-08-16", topic: "traffic" },
      "access",
    ],
    [
      {
        kind: "announcement",
        festivalId: "suzunari-toro",
        date: "2026-08-16",
        topic: "reception",
      },
      "etiquette",
    ],
    [
      {
        kind: "availability",
        lodgingName: "川べりの宿 すずなり",
        checkIn: "2026-08-15",
        checkOut: "2026-08-16",
        available: false,
        nightlyTotalYen: null,
        bookingUrl: null,
      },
      "lodging",
    ],
    [
      { kind: "weather", date: "2026-08-16", condition: "storm", precipitationPercent: null },
      "weather",
    ],
    [
      { kind: "reminder", slot: "eve", date: "2026-08-16", at: "18:00", itemId: null },
      "headquarters",
    ],
    [
      { kind: "reminder", slot: "last_return", date: "2026-08-16", at: "21:10", itemId: null },
      "access",
    ],
  ])("通知の中身から屋台を決める %#", (content, stall) => {
    expect(noticeStall(content)).toBe(stall);
  });
});

describe("GuideProposalSchema", () => {
  it("架空の提案を受け付ける", () => {
    expect(GuideProposalSchema.safeParse(fictionalProposal()).success).toBe(true);
  });

  it("提案の旅程は、もとの版の次の版", () => {
    expect(GuideProposalSchema.safeParse({ ...fictionalProposal(), baseVersion: 2 }).success).toBe(
      false,
    );
    const proposal = fictionalProposal();
    expect(
      GuideProposalSchema.safeParse({
        ...proposal,
        diff: { ...proposal.diff, fromVersion: 0 },
      }).success,
    ).toBe(false);
    expect(
      GuideProposalSchema.safeParse({ ...proposal, itinerary: fictionalItinerary() }).success,
    ).toBe(false);
  });

  it("別の旅の旅程を提案にできない", () => {
    expect(
      GuideProposalSchema.safeParse({ ...fictionalProposal(), tripId: "trip-other" }).success,
    ).toBe(false);
  });

  it("内容のハッシュと、作った時刻より後の期限を持つ", () => {
    expect(
      GuideProposalSchema.safeParse({ ...fictionalProposal(), contentHash: "abc" }).success,
    ).toBe(false);
    expect(
      GuideProposalSchema.safeParse({
        ...fictionalProposal(),
        expiresAt: "2026-08-10T06:00:00+09:00",
      }).success,
    ).toBe(false);
  });

  it("承認か却下のときだけ、決めた時刻を持つ", () => {
    const decidedAt = "2026-08-11T09:00:00+09:00";
    expect(GuideProposalSchema.safeParse({ ...fictionalProposal(), decidedAt }).success).toBe(
      false,
    );
    expect(
      GuideProposalSchema.safeParse({ ...fictionalProposal(), status: "approved" }).success,
    ).toBe(false);
    expect(
      GuideProposalSchema.safeParse({ ...fictionalProposal(), status: "approved", decidedAt })
        .success,
    ).toBe(true);
    expect(GuideProposalSchema.safeParse({ ...fictionalProposal(), status: "stale" }).success).toBe(
      true,
    );
  });
});

describe("提案の承認と却下の API", () => {
  it("承認には、見た提案の版とハッシュが要る", () => {
    const proposal = fictionalProposal();
    const approve = { decision: "approve", sessionId: "s-1" };
    expect(DecideProposalRequestSchema.safeParse(approve).success).toBe(false);
    expect(
      DecideProposalRequestSchema.safeParse({
        ...approve,
        baseVersion: proposal.baseVersion,
        contentHash: proposal.contentHash,
      }).success,
    ).toBe(true);
    expect(
      DecideProposalRequestSchema.safeParse({ decision: "reject", sessionId: "s-1" }).success,
    ).toBe(true);
  });

  it("適用した結果では、差分の版と旅程の版がそろう", () => {
    const { itinerary, diff } = fictionalProposal();
    expect(
      DecideProposalResponseSchema.safeParse({ outcome: "applied", change: { itinerary, diff } })
        .success,
    ).toBe(true);
    expect(
      DecideProposalResponseSchema.safeParse({
        outcome: "applied",
        change: { itinerary: fictionalItinerary(), diff },
      }).success,
    ).toBe(false);
    expect(
      DecideProposalResponseSchema.safeParse({ outcome: "unknown", currentVersion: null }).success,
    ).toBe(true);
  });
});

describe("GuideChatRequestSchema", () => {
  const request = { sessionId: "s-1", message: "雨だったらどうしますか" };

  it("相談の ID と発言で受け付ける。現在地は付けても付けなくてもよい", () => {
    expect(GuideChatRequestSchema.safeParse(request).success).toBe(true);
    expect(
      GuideChatRequestSchema.safeParse({ ...request, location: { lat: 35.12, lng: 136.08 } })
        .success,
    ).toBe(true);
  });

  it.each(["tripId", "uid", "itineraryId"])("本文に %s を持たない", (key) => {
    expect(GuideChatRequestSchema.safeParse({ ...request, [key]: "x" }).success).toBe(false);
  });

  it("写真は JPEG・PNG・WebP で、名乗った形式と中身が合うものだけを受ける", () => {
    for (const mediaType of GUIDE_PHOTO_TYPES) {
      const photo = fictionalPhoto({ mediaType });
      expect(GuideChatRequestSchema.safeParse({ ...request, photo }).success).toBe(true);
    }
    const png = fictionalPhoto({ mediaType: "image/png" });
    expect(
      GuideChatRequestSchema.safeParse({ ...request, photo: { ...png, mediaType: "image/jpeg" } })
        .success,
    ).toBe(false);
    expect(
      GuideChatRequestSchema.safeParse({
        ...request,
        photo: { mediaType: "image/gif", data: btoa("GIF89a0000000000") },
      }).success,
    ).toBe(false);
    // 画像でない中身（HTML）を画像と名乗っても受けない
    expect(
      GuideChatRequestSchema.safeParse({
        ...request,
        photo: { mediaType: "image/jpeg", data: btoa("<html><script>x</script></html>") },
      }).success,
    ).toBe(false);
  });

  it("写真の大きさの上限を超えるもの、base64 でないものは受けない", () => {
    const largest = fictionalPhoto({ bytes: MAX_GUIDE_PHOTO_BYTES });
    expect(base64ByteLength(largest.data)).toBe(MAX_GUIDE_PHOTO_BYTES);
    expect(GuidePhotoSchema.safeParse(largest).success).toBe(true);
    expect(
      GuidePhotoSchema.safeParse(fictionalPhoto({ bytes: MAX_GUIDE_PHOTO_BYTES + 1 })).success,
    ).toBe(false);
    const photo = fictionalPhoto();
    expect(
      GuidePhotoSchema.safeParse({ ...photo, data: `data:image/jpeg;base64,${photo.data}` })
        .success,
    ).toBe(false);
    expect(GuidePhotoSchema.safeParse({ ...photo, data: `${photo.data}A` }).success).toBe(false);
    expect(GuidePhotoSchema.safeParse({ ...photo, extra: 1 }).success).toBe(false);
  });

  it("発言の長さは店内の相談と同じ", () => {
    expect(GuideChatRequestSchema.safeParse({ ...request, message: "   " }).success).toBe(false);
    expect(
      GuideChatRequestSchema.safeParse({
        ...request,
        message: "あ".repeat(MAX_MESSAGE_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe("ガイドの手帳と、会話の続き", () => {
  it("手帳の項目は短い文だけ", () => {
    expect(GuideMemoItemSchema.safeParse(fictionalMemoItem()).success).toBe(true);
    expect(
      GuideMemoItemSchema.safeParse({ ...fictionalMemoItem(), text: "あ".repeat(81) }).success,
    ).toBe(false);
    expect(GuideMemoItemSchema.safeParse({ ...fictionalMemoItem(), text: " " }).success).toBe(
      false,
    );
  });

  it.each(["message", "text", "transcript", "summary"])(
    "続きの要約は、会話の文を入れる項目を持たない（%s）",
    (key) => {
      const summary = { turns: 3, topics: ["weather"], pendingProposalIds: [], lastTurnAt: null };
      expect(GuideResumeSummarySchema.safeParse(summary).success).toBe(true);
      expect(GuideResumeSummarySchema.safeParse({ ...summary, [key]: "発言" }).success).toBe(false);
    },
  );
});

describe("GuideStateResponseSchema", () => {
  const state = () => ({
    tripId: "trip-suzunari",
    version: 1,
    phase: "before",
    watch: fictionalTripWatch(),
    watchAvailable: true,
    notices: [fictionalNotice()],
    proposals: [fictionalProposal()],
    memo: [fictionalMemoItem()],
  });

  it("架空の旅の状態を受け付ける", () => {
    expect(GuideStateResponseSchema.safeParse(state()).success).toBe(true);
  });

  it.each([
    ["approved", "2026-08-11T09:00:00+09:00"],
    ["rejected", "2026-08-11T09:00:00+09:00"],
    ["expired", null],
    ["stale", null],
  ])("提案は承認待ちだけを返し、%s は返さない", (status, decidedAt) => {
    const proposal = { ...fictionalProposal(), status, decidedAt };
    expect(GuideProposalSchema.safeParse(proposal).success).toBe(true);
    expect(GuideStateResponseSchema.safeParse({ ...state(), proposals: [proposal] }).success).toBe(
      false,
    );
  });

  it("承認待ちの提案の数に上限がある", () => {
    const proposals = (count: number) => Array.from({ length: count }, () => fictionalProposal());
    expect(
      GuideStateResponseSchema.safeParse({
        ...state(),
        proposals: proposals(MAX_PENDING_PROPOSALS),
      }).success,
    ).toBe(true);
    expect(
      GuideStateResponseSchema.safeParse({
        ...state(),
        proposals: proposals(MAX_PENDING_PROPOSALS + 1),
      }).success,
    ).toBe(false);
  });
});

/** ガイドのイベントを1種類ずつ */
function exampleGuideEvents(): GuideSseEvent[] {
  return [
    {
      type: "guide.tool.start",
      data: { toolCallId: "g-1", tool: "read_trip", bubble: "旅程を見ています" },
    },
    {
      type: "guide.tool.end",
      data: { toolCallId: "g-1", tool: "read_trip", ok: true, bubble: "見ました" },
    },
    {
      type: "guide.sources",
      data: {
        messageId: "m-1",
        sources: [fictionalSource("2026")],
        checkedAt: "2026-08-10T20:00:00+09:00",
      },
    },
    { type: "guide.notice", data: { notice: fictionalNotice() } },
    { type: "guide.proposal", data: { proposal: fictionalProposal() } },
    { type: "guide.memo", data: { item: fictionalMemoItem() } },
    { type: "message.delta", data: { messageId: "m-1", text: "雨でも小雨なら開催します。" } },
    {
      type: "error",
      data: {
        code: "timeout",
        message: "時間がかかっています。もう一度送ってください。",
        retryable: true,
      },
    },
    { type: "guide.done", data: { phase: "before", unreadNotices: 1, pendingProposals: 1 } },
  ];
}

describe("GuideSseEventSchema", () => {
  it.each(exampleGuideEvents().map((event) => [event.type, event] as const))(
    "%s を受け付け、SSE の1件にして戻せる",
    (type, event) => {
      expect(GuideSseEventSchema.safeParse(event).success).toBe(true);
      const message = encodeGuideSseEvent(event);
      expect(message.event).toBe(type);
      expect(decodeGuideSseEvent(message)).toEqual(event);
    },
  );

  it("GUIDE_SSE_EVENT_TYPES は、スキーマにあるイベントの種類と一致する", () => {
    const types = GuideSseEventSchema.options.map((option) => option.shape.type.value);
    expect([...GUIDE_SSE_EVENT_TYPES].sort()).toEqual([...types].sort());
  });

  it("店内の相談のイベントの種類は増やさない", () => {
    const guideOnly = GUIDE_SSE_EVENT_TYPES.filter((type) => type.startsWith("guide."));
    expect(SSE_EVENT_TYPES.filter((type) => (guideOnly as string[]).includes(type))).toEqual([]);
    for (const event of exampleGuideEvents()) {
      if (!event.type.startsWith("guide.")) continue;
      expect(SseEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it("店内の相談の終わり（done）は、ガイドの接続では送らない", () => {
    expect(GuideSseEventSchema.safeParse({ type: "done", data: {} }).success).toBe(false);
  });

  it("出典のない返答の添え書きは送らない", () => {
    expect(
      GuideSseEventSchema.safeParse({
        type: "guide.sources",
        data: { messageId: "m-1", sources: [], checkedAt: "2026-08-10T20:00:00+09:00" },
      }).success,
    ).toBe(false);
  });

  it("不正なイベントは送らない", () => {
    const invalid = { type: "guide.memo", data: {} } as GuideSseEvent;
    expect(() => encodeGuideSseEvent(invalid)).toThrow();
  });
});

describe("roundLocation", () => {
  it("現在地を小数3桁（およそ100m）に丸める", () => {
    expect(roundLocation({ lat: 35.123456, lng: 136.567891 })).toEqual({
      lat: 35.123,
      lng: 136.568,
    });
    expect(roundLocation({ lat: -33.86549, lng: 151.20929 })).toEqual({
      lat: -33.865,
      lng: 151.209,
    });
  });
});
