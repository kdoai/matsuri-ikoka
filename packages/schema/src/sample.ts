import { z } from "zod";
import { ChatRequestSchema } from "./api";
import { IsoDateSchema, SlugSchema } from "./common";
import { SseEventSchema } from "./events";
import {
  CheckedChangeSchema,
  GuideChatRequestSchema,
  GuideNoticeSchema,
  GuideProposalSchema,
  type GuideSseEvent,
  GuideSseEventSchema,
  PatrolReportSchema,
  PatrolRequestSchema,
  TripWatchSchema,
} from "./guide";

// モックモードで再生する、記録した相談（data/samples/conversations/*.json）と、
// ガイドの相談と見回り（data/samples/guide/*.json）。
// キーがなくても、相談からしおりまでと、そのあとの付き添いを画面で確かめられるようにする。

/** 記録した1件のイベント。atMs はその発言を送ってからの経過時間（ミリ秒） */
export const RecordedEventSchema = z.strictObject({
  atMs: z.number().int().nonnegative(),
  event: SseEventSchema,
});

interface ToolCallStep {
  step: "start" | "end";
  toolCallId: string;
  tool: string;
}

/** 記録した返答の決まり：時間の順に並ぶ / 終わりのイベントは最後に1回だけ / ツールの終わりの前に開始がある */
function checkRecordedEvents<E extends { type: string }>(
  events: readonly { atMs: number; event: E }[],
  ctx: z.RefinementCtx,
  rules: { doneType: E["type"]; toolCall: (event: E) => ToolCallStep | null },
): void {
  events.forEach((recorded, index) => {
    const previous = events[index - 1];
    if (previous !== undefined && recorded.atMs < previous.atMs) {
      ctx.addIssue({
        code: "custom",
        path: ["events", index, "atMs"],
        message: "イベントは時間の順に並べてください",
      });
    }
  });

  const doneIndexes = events.flatMap(({ event }, index) =>
    event.type === rules.doneType ? [index] : [],
  );
  if (doneIndexes.length !== 1 || doneIndexes[0] !== events.length - 1) {
    ctx.addIssue({
      code: "custom",
      path: ["events"],
      message: `${rules.doneType} は最後に1回だけ送ります`,
    });
  }

  const started = new Map<string, string>();
  events.forEach(({ event }, index) => {
    const call = rules.toolCall(event);
    if (call === null) return;
    if (call.step === "start") {
      started.set(call.toolCallId, call.tool);
    } else if (started.get(call.toolCallId) !== call.tool) {
      ctx.addIssue({
        code: "custom",
        path: ["events", index, "event", "data", "toolCallId"],
        message: "ツールの終わりの前に、同じ toolCallId とツールの開始が必要です",
      });
    }
  });
}

/** 1つの発言と、それへの返答として流れたイベントの列 */
export const SampleTurnSchema = z
  .strictObject({
    request: ChatRequestSchema.omit({ sessionId: true }),
    events: z.array(RecordedEventSchema).min(1),
  })
  .superRefine((turn, ctx) => {
    checkRecordedEvents(turn.events, ctx, {
      doneType: "done",
      toolCall: (event) => {
        if (event.type === "tool.start") return { step: "start", ...event.data };
        if (event.type === "tool.end") return { step: "end", ...event.data };
        return null;
      },
    });
  });

export const SampleConversationSchema = z.strictObject({
  id: SlugSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  /** 相談した日。日程のルールでいう「今日」 */
  today: IsoDateSchema,
  turns: z.array(SampleTurnSchema).min(1),
});

export type RecordedEvent = z.infer<typeof RecordedEventSchema>;
export type SampleTurn = z.infer<typeof SampleTurnSchema>;
export type SampleConversation = z.infer<typeof SampleConversationSchema>;

// ---------------------------------------------------------------------------
// ガイドの相談と見回り

export const RecordedGuideEventSchema = z.strictObject({
  atMs: z.number().int().nonnegative(),
  event: GuideSseEventSchema,
});

function guideToolCall(event: GuideSseEvent): ToolCallStep | null {
  if (event.type === "guide.tool.start") return { step: "start", ...event.data };
  if (event.type === "guide.tool.end") return { step: "end", ...event.data };
  return null;
}

/** ガイドへの1つの発言と、それへの返答。location は記録しない（現在地を残さない） */
export const SampleGuideTurnSchema = z
  .strictObject({
    request: GuideChatRequestSchema.omit({ sessionId: true, location: true }),
    events: z.array(RecordedGuideEventSchema).min(1),
  })
  .superRefine((turn, ctx) => {
    checkRecordedEvents(turn.events, ctx, { doneType: "guide.done", toolCall: guideToolCall });
  });

/** 見回りの1回：見回り係への依頼、見回り係の報告、検問を通った変化 */
export const SamplePatrolSchema = z
  .strictObject({
    request: PatrolRequestSchema,
    report: PatrolReportSchema,
    changes: z.array(CheckedChangeSchema),
  })
  .refine((patrol) => patrol.report.patrolId === patrol.request.patrolId, {
    path: ["report", "patrolId"],
    message: "報告の patrolId は依頼と同じにしてください",
  });

export const SampleGuideSchema = z.strictObject({
  id: SlugSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  /** ガイドと話した日。旅の時期を決める「今日」 */
  today: IsoDateSchema,
  /** 旅のもとになる相談（data/samples/conversations の id） */
  conversation: SlugSchema,
  watch: TripWatchSchema,
  patrol: SamplePatrolSchema,
  notices: z.array(GuideNoticeSchema),
  proposals: z.array(GuideProposalSchema),
  turns: z.array(SampleGuideTurnSchema).min(1),
});

export type RecordedGuideEvent = z.infer<typeof RecordedGuideEventSchema>;
export type SampleGuideTurn = z.infer<typeof SampleGuideTurnSchema>;
export type SamplePatrol = z.infer<typeof SamplePatrolSchema>;
export type SampleGuide = z.infer<typeof SampleGuideSchema>;
