import { z } from "zod";
import { ChatRequestSchema } from "./api";
import { IsoDateSchema, SlugSchema } from "./common";
import { SseEventSchema } from "./events";

// モックモードで再生する、記録した相談（data/samples/conversations/*.json）。
// キーがなくても、相談からしおりまでを画面で確かめられるようにする。

/** 記録した1件のイベント。atMs はその発言を送ってからの経過時間（ミリ秒） */
export const RecordedEventSchema = z.strictObject({
  atMs: z.number().int().nonnegative(),
  event: SseEventSchema,
});

/** 1つの発言と、それへの返答として流れたイベントの列 */
export const SampleTurnSchema = z
  .strictObject({
    request: ChatRequestSchema.omit({ sessionId: true }),
    events: z.array(RecordedEventSchema).min(1),
  })
  .superRefine((turn, ctx) => {
    const { events } = turn;
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
      event.type === "done" ? [index] : [],
    );
    if (doneIndexes.length !== 1 || doneIndexes[0] !== events.length - 1) {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: "done は最後に1回だけ送ります",
      });
    }

    const started = new Map<string, string>();
    events.forEach(({ event }, index) => {
      if (event.type === "tool.start") {
        started.set(event.data.toolCallId, event.data.tool);
      } else if (
        event.type === "tool.end" &&
        started.get(event.data.toolCallId) !== event.data.tool
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "event", "data", "toolCallId"],
          message: "tool.end の前に、同じ toolCallId とツールの tool.start が必要です",
        });
      }
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
