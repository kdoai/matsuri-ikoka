import { z } from "zod";
import { MAX_MESSAGE_LENGTH } from "./api";
import {
  IsoDateSchema,
  IsoDateTimeSchema,
  LatLngSchema,
  LocalTimeSchema,
  SlugSchema,
  SourceSchema,
} from "./common";
import {
  defineSseEvent,
  ErrorEventSchema,
  ItineraryUpdatedEventSchema,
  MessageDeltaEventSchema,
  type SseMessage,
} from "./events";
import { ItineraryDiffSchema, ItinerarySchema, VerificationResultSchema } from "./itinerary";

// しおりのあとも旅に付き添うガイドの型（docs/spec/guide.md）。
// 役ごとに持てるものを型で分ける。
// - 見回り係へ渡すもの（Patrol*）と、見回り係から受け取るものは、公開の情報だけで、利用者の情報の項目がない
// - 検問を通ったもの（CheckedChange）は、決まった形の値と出典だけで、ページの文章の項目がない
// - 旅に結びつくもの（TripWatch・GuideNotice・GuideProposal）は、ガイドと画面の側だけで使う

const TextSchema = z.string().min(1);
const IdSchema = z.string().min(1).max(100);
const VersionSchema = z.number().int().min(1);
const SessionIdSchema = z.string().min(1);
const WebUrlSchema = z.url({ protocol: /^https?$/ });

// ---------------------------------------------------------------------------
// 旅の時期

/** 旅の時期。before 出発の前 / during 旅の間（初日から最終日まで）/ after 旅のあと */
export const TRIP_PHASES = ["before", "during", "after"] as const;
export const TripPhaseSchema = z.enum(TRIP_PHASES);
export type TripPhase = z.infer<typeof TripPhaseSchema>;

/** 旅程の日付と今日から、旅の時期を決める */
export function tripPhase(
  itinerary: { days: readonly { date: string }[] },
  today: string,
): TripPhase {
  const dates = itinerary.days.map((day) => day.date);
  if (dates.every((date) => today < date)) return "before";
  if (dates.every((date) => today > date)) return "after";
  return "during";
}

// ---------------------------------------------------------------------------
// 見回りの依頼（利用者の側。見回り係へは渡さない）

/** active 見回り中 / stopped 利用者が止めた / ended 旅が終わって止めた */
export const TRIP_WATCH_STATUSES = ["active", "stopped", "ended"] as const;

/** 頼まれた旅の見回り。頼まれた旅だけを見回り、旅が終わったら止める */
export const TripWatchSchema = z
  .strictObject({
    tripId: IdSchema,
    status: z.enum(TRIP_WATCH_STATUSES),
    startedAt: IsoDateTimeSchema,
    /** 見回りを止める日。旅の最終日の翌日を、旅程からコードで決める */
    endsOn: IsoDateSchema,
    /** 止めた時刻。見回り中は null */
    stoppedAt: IsoDateTimeSchema.nullable(),
    /** 最後に調べた時刻。まだ調べていなければ null */
    lastCheckedAt: IsoDateTimeSchema.nullable(),
  })
  .refine((watch) => (watch.status === "active") === (watch.stoppedAt === null), {
    path: ["stoppedAt"],
    message: "見回り中は stoppedAt を null にし、止めたら時刻を書いてください",
  });
export type TripWatch = z.infer<typeof TripWatchSchema>;

// ---------------------------------------------------------------------------
// 見回りの依頼（見回り係へ渡すもの）。公開の情報だけで、利用者の情報の項目がない

export const MAX_PATROL_TARGETS = 20;
export const MAX_PATROL_PAGES_PER_TARGET = 5;
export const MAX_PATROL_CHANGED_LINES = 40;
export const MAX_PATROL_LINE_LENGTH = 300;

/** 見回りの ID（`patrol-` と16桁の16進）。乱数で作り、旅や利用者の ID を入れられない形にする */
export const PatrolIdSchema = z
  .string()
  .regex(/^patrol-[a-f0-9]{16}$/, "patrol- と16桁の16進で書いてください");

/** 見回り係に読ませる理由。changed コードの比較で変わった行がある / unreadable コードでは読めなかった */
export const PATROL_PAGE_REASONS = ["changed", "unreadable"] as const;

/** 見回り係に読ませる公開のページ。開始の発言に URL を入れる */
export const PatrolPageSchema = z
  .strictObject({
    url: WebUrlSchema,
    reason: z.enum(PATROL_PAGE_REASONS),
    /** 前回から変わった行。読めなかったページでは空 */
    changedLines: z
      .array(z.string().min(1).max(MAX_PATROL_LINE_LENGTH))
      .max(MAX_PATROL_CHANGED_LINES),
  })
  .refine((page) => (page.reason === "changed") === page.changedLines.length > 0, {
    path: ["changedLines"],
    message: "changed には変わった行を書き、unreadable には書かないでください",
  });
export type PatrolPage = z.infer<typeof PatrolPageSchema>;

/** 見回りの対象。祭りの公開の情報と URL だけを持ち、祭りと開催日ごとに1つにまとめる */
export const PatrolTargetSchema = z.strictObject({
  festivalId: SlugSchema,
  festivalName: TextSchema.max(100),
  date: IsoDateSchema,
  pages: z.array(PatrolPageSchema).min(1).max(MAX_PATROL_PAGES_PER_TARGET),
});
export type PatrolTarget = z.infer<typeof PatrolTargetSchema>;

/** 見回り係のセッションへの依頼 */
export const PatrolRequestSchema = z
  .strictObject({
    patrolId: PatrolIdSchema,
    requestedAt: IsoDateTimeSchema,
    targets: z.array(PatrolTargetSchema).min(1).max(MAX_PATROL_TARGETS),
  })
  .superRefine((request, ctx) => {
    const seen = new Set<string>();
    request.targets.forEach((target, index) => {
      const key = `${target.festivalId}|${target.date}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["targets", index],
          message: "同じ祭りと開催日は1つにまとめてください",
        });
      }
      seen.add(key);
    });
  });
export type PatrolRequest = z.infer<typeof PatrolRequestSchema>;

// ---------------------------------------------------------------------------
// 見回りの結果（見回り係から受け取るもの）。信用しない入力で、検問を通るまで使わない

/** お知らせの中身。traffic 交通規制 / venue 会場 / program 内容 / reception 受付 / rain 雨のとき / other そのほか */
export const NOTICE_TOPICS = ["traffic", "venue", "program", "reception", "rain", "other"] as const;
export const NoticeTopicSchema = z.enum(NOTICE_TOPICS);
export type NoticeTopic = z.infer<typeof NoticeTopicSchema>;

/**
 * 1つの対象について見回り係が読んだこと。感想や説明の文は持たせない。
 * 調べた時刻・確度・差分は、検問のコードが決める
 */
export const PatrolFindingSchema = z.strictObject({
  festivalId: SlugSchema,
  date: IsoDateSchema,
  /** 見回り係の見立て。検問がコードで決め直す */
  result: VerificationResultSchema,
  /** ページで読めた開催の日時。読めなければ null にし、推測で埋めない */
  observed: z.strictObject({
    date: IsoDateSchema.nullable(),
    start: LocalTimeSchema.nullable(),
    end: LocalTimeSchema.nullable(),
  }),
  /** ページにあったお知らせの種類 */
  topics: z.array(NoticeTopicSchema).max(NOTICE_TOPICS.length),
  /** 開催日の文を、年を補わずにそのまま写したもの。検問の照合だけに使い、残さない */
  dateText: z.string().min(1).max(200).nullable(),
  /** 実際に読んだページ */
  pages: z.array(WebUrlSchema).max(MAX_PATROL_PAGES_PER_TARGET),
});
export type PatrolFinding = z.infer<typeof PatrolFindingSchema>;

export const PatrolReportSchema = z.strictObject({
  patrolId: PatrolIdSchema,
  findings: z.array(PatrolFindingSchema).max(MAX_PATROL_TARGETS),
});
export type PatrolReport = z.infer<typeof PatrolReportSchema>;

// ---------------------------------------------------------------------------
// 通知の中身。決まった形の値だけを持ち、ページの文章を持たない

/**
 * 通知の種類。schedule_change 開催の変更 / cancellation 中止 / announcement 主催者のお知らせ /
 * availability 宿の空き / weather 天気
 */
export const NOTICE_KINDS = [
  "schedule_change",
  "cancellation",
  "announcement",
  "availability",
  "weather",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** 開催の変更の1項目。順延で新しい日が分からなければ、date の after は null にする */
export const FestivalChangeSchema = z.discriminatedUnion("field", [
  z.strictObject({
    field: z.literal("date"),
    before: IsoDateSchema,
    after: IsoDateSchema.nullable(),
  }),
  z.strictObject({
    field: z.literal("start"),
    before: LocalTimeSchema.nullable(),
    after: LocalTimeSchema.nullable(),
  }),
  z.strictObject({
    field: z.literal("end"),
    before: LocalTimeSchema.nullable(),
    after: LocalTimeSchema.nullable(),
  }),
]);
export type FestivalChange = z.infer<typeof FestivalChangeSchema>;

/** 天気の知らせの理由。rain 雨 / storm 荒天 / heat 暑さ */
export const WEATHER_CONDITIONS = ["rain", "storm", "heat"] as const;

export const NoticeContentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("schedule_change"),
    festivalId: SlugSchema,
    date: IsoDateSchema,
    changes: z
      .array(FestivalChangeSchema)
      .min(1)
      .refine((changes) => changes.every((change) => change.before !== change.after), {
        message: "変わっていない項目は書かないでください",
      })
      .refine((changes) => new Set(changes.map((change) => change.field)).size === changes.length, {
        message: "同じ項目を重ねて書かないでください",
      }),
  }),
  z.strictObject({
    kind: z.literal("cancellation"),
    festivalId: SlugSchema,
    date: IsoDateSchema,
  }),
  z.strictObject({
    kind: z.literal("announcement"),
    festivalId: SlugSchema,
    date: IsoDateSchema,
    topic: NoticeTopicSchema,
  }),
  z
    .strictObject({
      kind: z.literal("availability"),
      lodgingName: TextSchema.max(60),
      checkIn: IsoDateSchema,
      checkOut: IsoDateSchema,
      available: z.boolean(),
      /** 1泊の合計。分からなければ null */
      nightlyTotalYen: z.number().int().nonnegative().nullable(),
      bookingUrl: WebUrlSchema.nullable(),
    })
    .refine((content) => content.checkIn < content.checkOut, {
      path: ["checkOut"],
      message: "チェックアウトはチェックインより後にしてください",
    }),
  z.strictObject({
    kind: z.literal("weather"),
    date: IsoDateSchema,
    condition: z.enum(WEATHER_CONDITIONS),
    precipitationPercent: z.number().int().min(0).max(100).nullable(),
  }),
]);
export type NoticeContent = z.infer<typeof NoticeContentSchema>;

/** 縁日の通りの屋台。lodging 宿 / access 行き方 / etiquette 作法 / food 食べ物 / weather 天気 / headquarters 本部のテント（開催情報） */
export const GUIDE_STALLS = [
  "lodging",
  "access",
  "etiquette",
  "food",
  "weather",
  "headquarters",
] as const;
export const GuideStallSchema = z.enum(GUIDE_STALLS);
export type GuideStall = z.infer<typeof GuideStallSchema>;

const TOPIC_STALLS: Record<NoticeTopic, GuideStall> = {
  traffic: "access",
  venue: "headquarters",
  program: "headquarters",
  reception: "etiquette",
  rain: "weather",
  other: "headquarters",
};

/** 通知で提灯を灯す屋台。通知の中身だけから決める */
export function noticeStall(content: NoticeContent): GuideStall {
  switch (content.kind) {
    case "schedule_change":
    case "cancellation":
      return "headquarters";
    case "announcement":
      return TOPIC_STALLS[content.topic];
    case "availability":
      return "lodging";
    case "weather":
      return "weather";
  }
}

// ---------------------------------------------------------------------------
// 検問を通った変化。まだどの旅にも結びつかない

/** 同じ変化から通知を2度作らないための値。変化の中身からコードが計算する */
export const FingerprintSchema = z.string().regex(/^[a-f0-9]{16,64}$/, "16進の値で書いてください");

/**
 * 検問を通った出典。確度はコードが決める。推定は通さない。
 * ページの題名はページの文章なので持たない
 */
export const CheckedSourceSchema = SourceSchema.omit({ title: true }).refine(
  (source) => source.confidence !== "inferred",
  { path: ["confidence"], message: "推定の出典は通知に使えません" },
);
export type CheckedSource = z.infer<typeof CheckedSourceSchema>;

/** 中止や日程の変更は、公式か2つ以上の情報源で一致したときだけ知らせる */
function checkFirmSources(
  value: { content: NoticeContent; sources: readonly CheckedSource[] },
  ctx: z.RefinementCtx,
): void {
  const { kind } = value.content;
  if (kind !== "schedule_change" && kind !== "cancellation") return;
  if (!value.sources.some((s) => s.confidence === "official" || s.confidence === "corroborated")) {
    ctx.addIssue({
      code: "custom",
      path: ["sources"],
      message: "中止と日程の変更には、公式か2つ以上の情報源で一致した出典が必要です",
    });
  }
}

const checkedChangeFields = {
  fingerprint: FingerprintSchema,
  content: NoticeContentSchema,
  /** 出典。必ず1つ以上 */
  sources: z.array(CheckedSourceSchema).min(1),
  /** 調べた時刻。コードが付ける */
  checkedAt: IsoDateTimeSchema,
};

export const CheckedChangeSchema = z
  .strictObject(checkedChangeFields)
  .superRefine(checkFirmSources);
export type CheckedChange = z.infer<typeof CheckedChangeSchema>;

// ---------------------------------------------------------------------------
// 通知（旅に結びついたもの）

/** 1つの旅に残す通知の数の上限 */
export const MAX_NOTICES_PER_TRIP = 50;

export const GuideNoticeSchema = z
  .strictObject({
    ...checkedChangeFields,
    id: IdSchema,
    tripId: IdSchema,
    /** 一覧に出す短い文。通知の中身からコードが決まった型で作る */
    summary: TextSchema.max(200),
    /** 影響する旅程の予定の ID */
    affectedItemIds: z.array(TextSchema).max(40),
    /** 組み直しの提案があれば、その ID */
    proposalId: IdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    /** 読んだ時刻。未読なら null */
    readAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine(checkFirmSources);
export type GuideNotice = z.infer<typeof GuideNoticeSchema>;

// ---------------------------------------------------------------------------
// 組み直しの提案。承認されるまで旅程を変えない

/**
 * 提案の状態。pending 承認待ち / approved 承認して新しい版にした / rejected 断った /
 * expired 期限が過ぎた / stale 提案のあとに旅程が変わった
 */
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "expired", "stale"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** 1つの旅で承認を待てる提案の数の上限 */
export const MAX_PENDING_PROPOSALS = 10;

/** 提案した旅程の内容のハッシュ（SHA-256）。コードが計算し、承認のときに照らし合わせる */
export const ContentHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "SHA-256 の16進で書いてください");

export const GuideProposalSchema = z
  .strictObject({
    id: IdSchema,
    tripId: IdSchema,
    status: z.enum(PROPOSAL_STATUSES),
    /** もとになった通知。利用者が会話で頼んだ変更なら空 */
    noticeIds: z.array(IdSchema).max(MAX_NOTICES_PER_TRIP),
    /** 何をどう直すかの短い文 */
    summary: TextSchema.max(200),
    /** もとにした旅程の版 */
    baseVersion: VersionSchema,
    contentHash: ContentHashSchema,
    /** 提案した旅程。承認されるまで、旅の版には入らない */
    itinerary: ItinerarySchema,
    diff: ItineraryDiffSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    /** 承認か却下をした時刻。それ以外の状態では null */
    decidedAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine((proposal, ctx) => {
    const { itinerary, diff, baseVersion } = proposal;
    if (itinerary.id !== proposal.tripId) {
      ctx.addIssue({
        code: "custom",
        path: ["itinerary", "id"],
        message: "提案の旅程は、同じ旅のものにしてください",
      });
    }
    if (diff.fromVersion !== baseVersion || diff.toVersion !== baseVersion + 1) {
      ctx.addIssue({
        code: "custom",
        path: ["diff"],
        message: "差分は、もとの版から次の版へのものにしてください",
      });
    }
    if (itinerary.version !== baseVersion + 1) {
      ctx.addIssue({
        code: "custom",
        path: ["itinerary", "version"],
        message: "提案の旅程の版は、もとの版の次にしてください",
      });
    }
    if (Date.parse(proposal.expiresAt) <= Date.parse(proposal.createdAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "期限は作った時刻より後にしてください",
      });
    }
    const decided = proposal.status === "approved" || proposal.status === "rejected";
    if (decided !== (proposal.decidedAt !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "承認か却下のときだけ decidedAt を書いてください",
      });
    }
  });
export type GuideProposal = z.infer<typeof GuideProposalSchema>;

// ---------------------------------------------------------------------------
// ガイドの手帳と、会話の続き

export const MAX_MEMO_ITEMS = 30;
export const MAX_MEMO_TEXT_LENGTH = 80;

/** 手帳の項目の種類。companion 同行者 / pace 歩くペース / avoid 避けたいこと / food 食べ物 / other そのほか */
export const GUIDE_MEMO_KINDS = ["companion", "pace", "avoid", "food", "other"] as const;

const MemoTextSchema = z.string().trim().min(1).max(MAX_MEMO_TEXT_LENGTH);

/** 手帳の1項目。旅ごとに持ち、利用者が話したことだけを残す。利用者が見て、直して、消せる */
export const GuideMemoItemSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(GUIDE_MEMO_KINDS),
  text: MemoTextSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type GuideMemoItem = z.infer<typeof GuideMemoItemSchema>;

/** 話題。使ったツールからコードが決める */
export const GUIDE_TOPICS = [
  "festival",
  "etiquette",
  "move",
  "lodging",
  "food",
  "weather",
  "belongings",
  "trouble",
  "change",
  "other",
] as const;

/**
 * 接続が別のインスタンスに届いたときの続きに使う、コードが書く要約。
 * 会話の文を入れる項目を持たない（会話の全文は残さない）
 */
export const GuideResumeSummarySchema = z.strictObject({
  turns: z.number().int().nonnegative(),
  topics: z.array(z.enum(GUIDE_TOPICS)).max(GUIDE_TOPICS.length),
  /** 承認を待っている提案 */
  pendingProposalIds: z.array(IdSchema).max(MAX_PENDING_PROPOSALS),
  lastTurnAt: IsoDateTimeSchema.nullable(),
});
export type GuideResumeSummary = z.infer<typeof GuideResumeSummarySchema>;

// ---------------------------------------------------------------------------
// ガイドの API（docs/spec/guide.md）。旅は相談から決めるので、本文に旅の ID や利用者の ID を持たない

/** 相談を指すだけの本文 */
export const GuideSessionRefSchema = z.strictObject({ sessionId: SessionIdSchema });
export type GuideSessionRef = z.infer<typeof GuideSessionRefSchema>;

/** POST /api/guide/open の本文。残した旅を開いて、ガイドと話す相談を作る（持ち主だけ） */
export const GuideOpenRequestSchema = z.strictObject({ tripId: IdSchema });
export type GuideOpenRequest = z.infer<typeof GuideOpenRequestSchema>;

/** POST /api/guide/chat の本文。返答は SSE（GuideSseEventSchema）で返す */
export const GuideChatRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  /** この発言のときだけ使う現在地。保存せず、ログにも残さない */
  location: LatLngSchema.optional(),
});
export type GuideChatRequest = z.infer<typeof GuideChatRequestSchema>;

/** POST /api/guide/state の応答。ガイドの画面が読むものをまとめて返す */
export const GuideStateResponseSchema = z.strictObject({
  tripId: IdSchema,
  /** いまの旅程の版 */
  version: VersionSchema,
  phase: TripPhaseSchema,
  /** 見回りを頼んでいなければ null */
  watch: TripWatchSchema.nullable(),
  /** この環境で見回りが動くか。動かなければ、見回りを頼めない（頼んでも、だれも見回らない） */
  watchAvailable: z.boolean(),
  /** 新しい順 */
  notices: z.array(GuideNoticeSchema).max(MAX_NOTICES_PER_TRIP),
  /** 承認を待っている提案だけ。提案は旅程をまるごと持つので、決まったものは返さない */
  proposals: z
    .array(
      GuideProposalSchema.refine((proposal) => proposal.status === "pending", {
        path: ["status"],
        message: "承認を待っている提案だけを返してください",
      }),
    )
    .max(MAX_PENDING_PROPOSALS),
  memo: z.array(GuideMemoItemSchema).max(MAX_MEMO_ITEMS),
});
export type GuideStateResponse = z.infer<typeof GuideStateResponseSchema>;

/** POST /api/guide/notices/read の本文 */
export const MarkNoticesReadRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  noticeIds: z.array(IdSchema).min(1).max(MAX_NOTICES_PER_TRIP),
});
export type MarkNoticesReadRequest = z.infer<typeof MarkNoticesReadRequestSchema>;

/** POST /api/guide/notices/read の応答 */
export const MarkNoticesReadResponseSchema = z.strictObject({
  unread: z.number().int().nonnegative(),
});
export type MarkNoticesReadResponse = z.infer<typeof MarkNoticesReadResponseSchema>;

/** POST /api/guide/watch の本文。応答は TripWatchSchema */
export const SetTripWatchRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  action: z.enum(["start", "stop"]),
});
export type SetTripWatchRequest = z.infer<typeof SetTripWatchRequestSchema>;

/** POST /api/guide/proposals/:id/decision の本文。承認は、見た提案の版とハッシュを添える */
export const DecideProposalRequestSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("approve"),
    sessionId: SessionIdSchema,
    baseVersion: VersionSchema,
    contentHash: ContentHashSchema,
  }),
  z.strictObject({ decision: z.literal("reject"), sessionId: SessionIdSchema }),
]);
export type DecideProposalRequest = z.infer<typeof DecideProposalRequestSchema>;

/** 版が増えたときの結果：新しい旅程と、前の版からの差分（itinerary.updated の中身と同じ形） */
export const TripChangeSchema = ItineraryUpdatedEventSchema.shape.data;
export type TripChange = z.infer<typeof TripChangeSchema>;

/**
 * POST /api/guide/proposals/:id/decision の応答。
 * applied 新しい版になった（同じ承認が2回届いても同じ結果を返し、版は1つしか増えない）/ rejected 断った /
 * stale 提案のあとに旅程が変わった / expired 期限が過ぎた /
 * unknown 適用できたか確かめられない（自動でやり直さない。いまの版を見せる）
 */
export const DecideProposalResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("applied"), change: TripChangeSchema }),
  z.strictObject({ outcome: z.literal("rejected") }),
  z.strictObject({ outcome: z.literal("stale"), currentVersion: VersionSchema }),
  z.strictObject({ outcome: z.literal("expired") }),
  z.strictObject({ outcome: z.literal("unknown"), currentVersion: VersionSchema.nullable() }),
]);
export type DecideProposalResponse = z.infer<typeof DecideProposalResponseSchema>;

/** POST /api/guide/revert の本文。応答は TripChangeSchema。戻す操作も新しい版として残す */
export const RevertTripRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  toVersion: VersionSchema,
});
export type RevertTripRequest = z.infer<typeof RevertTripRequestSchema>;

/** POST /api/guide/memo/:id の本文。応答は GuideMemoItemSchema */
export const UpdateGuideMemoRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  text: MemoTextSchema,
});
export type UpdateGuideMemoRequest = z.infer<typeof UpdateGuideMemoRequestSchema>;

// ---------------------------------------------------------------------------
// ガイドの SSE イベント。店内の相談（SseEventSchema）とは別の接続で流す

/** ガイドのツール。どれも入力に旅の ID や利用者の ID を持たず、サーバーの文脈から決める */
export const GUIDE_TOOL_NAMES = [
  "read_trip",
  "list_notices",
  "research_web",
  "get_weather",
  "research_route",
  "search_nearby",
  "propose_change",
  "save_memo",
] as const;
export const GuideToolNameSchema = z.enum(GUIDE_TOOL_NAMES);
export type GuideToolName = z.infer<typeof GuideToolNameSchema>;

/** ツールを呼ぶ前 */
export const GuideToolStartEventSchema = defineSseEvent(
  "guide.tool.start",
  z.strictObject({
    toolCallId: TextSchema,
    tool: GuideToolNameSchema,
    /** 吹き出しの文章。サーバーが決まった型から作る */
    bubble: TextSchema,
  }),
);

/** ツールが終わった */
export const GuideToolEndEventSchema = defineSseEvent(
  "guide.tool.end",
  z.strictObject({
    toolCallId: TextSchema,
    tool: GuideToolNameSchema,
    ok: z.boolean(),
    bubble: TextSchema,
  }),
);

/** 返答に添える出典と、調べた時刻 */
export const GuideSourcesEventSchema = defineSseEvent(
  "guide.sources",
  z.strictObject({
    messageId: TextSchema,
    sources: z.array(SourceSchema).min(1),
    checkedAt: IsoDateTimeSchema,
  }),
);

/** 会話の中で知らせた通知 */
export const GuideNoticeEventSchema = defineSseEvent(
  "guide.notice",
  z.strictObject({ notice: GuideNoticeSchema }),
);

/** 組み直しの提案ができた。旅程はまだ変わっていない */
export const GuideProposalEventSchema = defineSseEvent(
  "guide.proposal",
  z.strictObject({ proposal: GuideProposalSchema }),
);

/** 手帳に項目を残した。利用者に分かるように知らせる */
export const GuideMemoEventSchema = defineSseEvent(
  "guide.memo",
  z.strictObject({ item: GuideMemoItemSchema }),
);

/** 1つの発言への返答の終わり */
export const GuideDoneEventSchema = defineSseEvent(
  "guide.done",
  z.strictObject({
    phase: TripPhaseSchema,
    unreadNotices: z.number().int().nonnegative(),
    pendingProposals: z.number().int().nonnegative(),
  }),
);

export const GuideSseEventSchema = z.discriminatedUnion("type", [
  GuideToolStartEventSchema,
  GuideToolEndEventSchema,
  GuideSourcesEventSchema,
  GuideNoticeEventSchema,
  GuideProposalEventSchema,
  GuideMemoEventSchema,
  MessageDeltaEventSchema,
  ErrorEventSchema,
  GuideDoneEventSchema,
]);
export type GuideSseEvent = z.infer<typeof GuideSseEventSchema>;
export type GuideSseEventType = GuideSseEvent["type"];
export type GuideSseEventOf<T extends GuideSseEventType> = Extract<GuideSseEvent, { type: T }>;

export const GUIDE_SSE_EVENT_TYPES = [
  "guide.tool.start",
  "guide.tool.end",
  "guide.sources",
  "guide.notice",
  "guide.proposal",
  "guide.memo",
  "message.delta",
  "error",
  "guide.done",
] as const satisfies readonly GuideSseEventType[];

/** イベントを SSE の1件に変換する。送る前に検証し、不正なイベントは送らない */
export function encodeGuideSseEvent(event: GuideSseEvent): SseMessage {
  const valid = GuideSseEventSchema.parse(event);
  return { event: valid.type, data: JSON.stringify(valid.data) };
}

/** 受け取った SSE の1件を検証してイベントに戻す。形が違えば例外を投げる */
export function decodeGuideSseEvent(message: SseMessage): GuideSseEvent {
  return GuideSseEventSchema.parse({ type: message.event, data: JSON.parse(message.data) });
}
