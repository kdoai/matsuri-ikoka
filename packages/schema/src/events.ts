import { z } from "zod";
import {
  ConfidenceSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LatLngSchema,
  LocalTimeSchema,
  SlugSchema,
  SourceSchema,
} from "./common";
import { NEARBY_KINDS } from "./festival";
import { ItineraryDiffSchema, ItinerarySchema, VerificationResultSchema } from "./itinerary";
import { PartialTripConditionsSchema, PreferencesSchema } from "./preferences";
import {
  CandidateTravelSchema,
  MAX_SEARCH_ATTEMPTS,
  MAX_SEARCH_SUGGESTIONS,
  SearchMissSchema,
  SearchSuggestionSchema,
} from "./search";

// 画面へ送る SSE のイベント。1つの発言に1本の接続で返し、最後に必ず done を送る。
// 画面はこのイベントだけを見て、ストアを更新する（どのエージェントが動いているかは知らない）。

const TextSchema = z.string().min(1);

/** スタッフ：コンシェルジュ / 祭り調査係 / 周辺係 / 旅程係 */
export const STAFF_IDS = ["concierge", "researcher", "scout", "planner"] as const;
export const StaffIdSchema = z.enum(STAFF_IDS);

/** スタッフの作業の種類：祭りを探す / 寄り道を探す / 道のりを調べる */
export const STAFF_TASKS = ["find_festivals", "find_nearby", "plan_route"] as const;

export const TOOL_NAMES = [
  "search_festivals",
  "search_nearby",
  "get_access",
  "research_route",
  "get_weather",
  "search_lodging",
  "update_itinerary",
  "verify_festival",
] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);

/**
 * 調べ直しを頼む中身：lunch 昼ごはんの店 / dinner 夕ごはんの店 / sightseeing 寄り道 /
 * route 行き方（乗り換え） / last_mile 駅から会場までの移動 / lodging 宿
 */
export const REDO_SUBJECTS = [
  "lunch",
  "dinner",
  "sightseeing",
  "route",
  "last_mile",
  "lodging",
] as const;
export const RedoSubjectSchema = z.enum(REDO_SUBJECTS);

/**
 * 会話の状態。サーバーが持ち、画面はこれに合わせて切り替わる。
 * hearing 聞き取り / candidates 祭り候補 / itinerary 旅程案 / revising 修正 /
 * verifying 確定前の確認 / shiori 旅のしおり
 */
export const CONVERSATION_STAGES = [
  "hearing",
  "candidates",
  "itinerary",
  "revising",
  "verifying",
  "shiori",
] as const;
export const ConversationStageSchema = z.enum(CONVERSATION_STAGES);

/** 候補カードに出す祭り（search_festivals の結果） */
export const FestivalCandidateSchema = z.strictObject({
  festivalId: SlugSchema,
  name: TextSchema,
  date: IsoDateSchema,
  start: LocalTimeSchema.nullable(),
  end: LocalTimeSchema.nullable(),
  venueName: TextSchema,
  /** 表示用の開催地（例：滋賀県鈴鳴町） */
  place: TextSchema,
  /** 希望日からのずれ（日）。0 は希望日、負は前、正は後 */
  daysFromWish: z.number().int(),
  confidence: ConfidenceSchema,
  /** 開催が確認できているか。false なら「未確認」と表示し、確定した旅程には入れない */
  confirmed: z.boolean(),
  highlight: TextSchema,
  source: SourceSchema,
  /** 出発の駅からの片道の所要時間を、条件に照らした値（日帰りの上限と比べた結果を含む） */
  travel: CandidateTravelSchema.optional(),
  /**
   * 候補を出す前の、公式の情報での確かめの結果（とってある結果があるときだけ）。
   * まだ確かめていなければ付けず、確かめ終わったら festival.verified（scope: candidate）で届く
   */
  check: z
    .strictObject({
      result: VerificationResultSchema,
      checkedAt: IsoDateTimeSchema,
    })
    .optional(),
});

/** 地図に打つ周辺の場所（search_nearby の結果） */
export const SpotPinSchema = z.strictObject({
  spotId: SlugSchema,
  name: TextSchema,
  kind: z.enum(NEARBY_KINDS),
  location: LatLngSchema,
});

export const MAX_CANDIDATES = 3;

/** 条件のどれか1つだけから外れる祭り（「この祭りならやっています」）。外れている点を添える */
export const NearMissSchema = z.strictObject({
  candidate: FestivalCandidateSchema,
  miss: SearchMissSchema,
});

/** 検索の結果：found 条件に合う祭りがある / none 条件に合う祭りが見つからなかった */
export const SEARCH_STATUSES = ["found", "none"] as const;

/** search_festivals の結果のうち、条件の検査と次の手（コードで決めたもの） */
export const SearchOutcomeSchema = z.strictObject({
  status: z.enum(SEARCH_STATUSES),
  /** 条件から外した祭りの数（条件ごと。いちばんはじめに外れた条件で数える） */
  excluded: z.strictObject({
    date: z.number().int().nonnegative(),
    travel: z.number().int().nonnegative(),
    area: z.number().int().nonnegative(),
  }),
  nearMisses: z.array(NearMissSchema).max(MAX_CANDIDATES),
  suggestions: z.array(SearchSuggestionSchema).max(MAX_SEARCH_SUGGESTIONS),
  /** 探した回数（はじめの検索と、条件を変えて数え直した回数） */
  attempts: z.number().int().min(1).max(MAX_SEARCH_ATTEMPTS),
});

/** 利用者に見せるエラーの種類 */
export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "timeout",
  "tool_failed",
  "upstream_unavailable",
  "internal",
] as const;

function event<const T extends string, S extends z.ZodType>(type: T, data: S) {
  return z.strictObject({ type: z.literal(type), data });
}

/** サブエージェント（スタッフ）が作業を始めた */
export const StaffStartEventSchema = event(
  "staff.start",
  z.strictObject({
    staff: StaffIdSchema,
    task: z.enum(STAFF_TASKS),
    /** 吹き出しの文章。サーバーが決まった型から作る */
    bubble: TextSchema,
  }),
);

/** ツールを呼ぶ前 */
export const ToolStartEventSchema = event(
  "tool.start",
  z.strictObject({
    toolCallId: TextSchema,
    tool: ToolNameSchema,
    staff: StaffIdSchema,
    bubble: TextSchema,
    /** 店内のようすの窓に出す、くわしい文。吹き出しより長い */
    detail: TextSchema.optional(),
  }),
);

/** ツールが終わった。候補や場所は、そのツールのときだけ付く */
export const ToolEndEventSchema = event(
  "tool.end",
  z
    .strictObject({
      toolCallId: TextSchema,
      tool: ToolNameSchema,
      staff: StaffIdSchema,
      ok: z.boolean(),
      bubble: TextSchema,
      /** 店内のようすの窓に出す、くわしい文（見つけたものの件数と代表の1件など） */
      detail: TextSchema.optional(),
      /** 見つかった件数。件数のないツールでは null */
      count: z.number().int().nonnegative().nullable(),
      candidates: z.array(FestivalCandidateSchema).max(MAX_CANDIDATES).optional(),
      /** 条件の検査と次の手（search_festivals の結果にだけ付く） */
      search: SearchOutcomeSchema.optional(),
      spots: z.array(SpotPinSchema).optional(),
    })
    .superRefine((data, ctx) => {
      if (data.candidates !== undefined && data.tool !== "search_festivals") {
        ctx.addIssue({
          code: "custom",
          path: ["candidates"],
          message: "candidates は search_festivals の結果にだけ付けます",
        });
      }
      if (data.search !== undefined && data.tool !== "search_festivals") {
        ctx.addIssue({
          code: "custom",
          path: ["search"],
          message: "search は search_festivals の結果にだけ付けます",
        });
      }
      if (data.spots !== undefined && data.tool !== "search_nearby") {
        ctx.addIssue({
          code: "custom",
          path: ["spots"],
          message: "spots は search_nearby の結果にだけ付けます",
        });
      }
    }),
);

/**
 * スタッフどうしの調べ直しの頼み（request）と、その受け（accept）。
 * 足りないもの（subject）から、サーバーが決まった型で吹き出しを作る
 */
export const StaffRedoEventSchema = event(
  "staff.redo",
  z
    .strictObject({
      kind: z.enum(["request", "accept"]),
      from: StaffIdSchema,
      to: StaffIdSchema,
      subject: RedoSubjectSchema,
      bubble: TextSchema,
      detail: TextSchema.optional(),
    })
    .refine((data) => data.from !== data.to, {
      path: ["to"],
      message: "頼む相手は、頼む人と別のスタッフにしてください",
    }),
);

/** 旅程が保存された。画面は旅程全体を置き換え、差分で変わった予定に色を付ける */
export const ItineraryUpdatedEventSchema = event(
  "itinerary.updated",
  z
    .strictObject({ itinerary: ItinerarySchema, diff: ItineraryDiffSchema })
    .refine((data) => data.diff.toVersion === data.itinerary.version, {
      path: ["diff", "toVersion"],
      message: "差分の toVersion は旅程の版と同じにしてください",
    }),
);

/**
 * 確かめる場面：candidate 候補を出す前の確かめ（候補の祭りと日付ごと）/
 * itinerary 確定前の、旅程の主役の祭りの再確認
 */
export const VERIFICATION_SCOPES = ["candidate", "itinerary"] as const;

/**
 * 公式情報で開催を確かめた。scope がないときは itinerary（確定前の再確認）。
 * candidate の結果は候補カードにだけ付け、旅程の再確認の結果にはしない
 */
export const FestivalVerifiedEventSchema = event(
  "festival.verified",
  z
    .strictObject({
      festivalId: SlugSchema,
      /** 確かめた開催日 */
      date: IsoDateSchema.optional(),
      scope: z.enum(VERIFICATION_SCOPES).optional(),
      result: VerificationResultSchema,
      checkedAt: IsoDateTimeSchema,
      sources: z.array(SourceSchema),
      note: TextSchema.optional(),
    })
    .refine((data) => data.result !== "as_planned" || data.sources.length > 0, {
      path: ["sources"],
      message: "予定どおりと確認するには出典が必要です",
    }),
);

/** コンシェルジュの返答の続き。同じ messageId の text をつなげると1つの返答になる */
export const MessageDeltaEventSchema = event(
  "message.delta",
  z.strictObject({ messageId: TextSchema, text: TextSchema }),
);

/** エラー。message は利用者に見せる短い一文で、詳細はサーバーのログに残す */
export const ErrorEventSchema = event(
  "error",
  z.strictObject({
    code: z.enum(ERROR_CODES),
    message: TextSchema,
    retryable: z.boolean(),
  }),
);

/** 1つの発言への返答の終わり。会話の状態と、読み取れた条件・こだわりを返す */
export const DoneEventSchema = event(
  "done",
  z.strictObject({
    stage: ConversationStageSchema,
    conditions: PartialTripConditionsSchema,
    preferences: PreferencesSchema,
  }),
);

export const SseEventSchema = z.discriminatedUnion("type", [
  StaffStartEventSchema,
  ToolStartEventSchema,
  ToolEndEventSchema,
  StaffRedoEventSchema,
  ItineraryUpdatedEventSchema,
  FestivalVerifiedEventSchema,
  MessageDeltaEventSchema,
  ErrorEventSchema,
  DoneEventSchema,
]);

export type StaffId = z.infer<typeof StaffIdSchema>;
export type ToolName = z.infer<typeof ToolNameSchema>;
export type RedoSubject = z.infer<typeof RedoSubjectSchema>;
export type ConversationStage = z.infer<typeof ConversationStageSchema>;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type FestivalCandidate = z.infer<typeof FestivalCandidateSchema>;
export type NearMiss = z.infer<typeof NearMissSchema>;
export type SearchOutcome = z.infer<typeof SearchOutcomeSchema>;
export type SpotPin = z.infer<typeof SpotPinSchema>;
export type SseEvent = z.infer<typeof SseEventSchema>;
export type SseEventType = SseEvent["type"];
export type SseEventOf<T extends SseEventType> = Extract<SseEvent, { type: T }>;

export const SSE_EVENT_TYPES = [
  "staff.start",
  "tool.start",
  "tool.end",
  "staff.redo",
  "itinerary.updated",
  "festival.verified",
  "message.delta",
  "error",
  "done",
] as const satisfies readonly SseEventType[];

/** SSE の1件（`event:` と `data:` の行）。Hono の streamSSE や fetch-event-source の形に合わせる */
export interface SseMessage {
  event: string;
  data: string;
}

/** イベントを SSE の1件に変換する。送る前に検証し、不正なイベントは送らない */
export function encodeSseEvent(event: SseEvent): SseMessage {
  const valid = SseEventSchema.parse(event);
  return { event: valid.type, data: JSON.stringify(valid.data) };
}

/** 受け取った SSE の1件を検証してイベントに戻す。形が違えば例外を投げる */
export function decodeSseEvent(message: SseMessage): SseEvent {
  return SseEventSchema.parse({ type: message.event, data: JSON.parse(message.data) });
}
