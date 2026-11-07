import {
  type EmergencyContact,
  GUIDE_STALLS,
  type GuideMemoItem,
  type GuideNotice,
  type GuideProposal,
  type GuideSseEvent,
  type GuideStall,
  type GuideStateResponse,
  type GuideToolName,
  noticeStall,
  type Source,
  type TripPhase,
} from "@matsuri-ikoka/schema";
import type { ClientError, ClientErrorCode } from "./types";

// しおりのあとの縁日の通りとガイドの状態。正しい状態はここ（ストアの guide）だけが持つ。
// 画面の 2D と 3D は、どちらもこの形を読むだけにする。SSE のイベントは applyGuideEvent でこの形の更新に変える。

/**
 * ガイドと話せるか。idle まだ確かめていない / loading 確かめている / ready 話せる /
 * unavailable この環境や相談では話せない（屋台の情報は読める）/ failed 一時的に読めない（もう一度試せる）
 */
export type GuideAvailability = "idle" | "loading" | "ready" | "unavailable" | "failed";

/** ガイドが立つ場所。home 通りの入り口 / player 旅人のそば / それ以外は、その屋台の脇 */
export type GuideSpot = "home" | "player" | GuideStall;

export type GuideEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "guide"; id: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; tool: GuideToolName; bubble: string; running: boolean; ok: boolean }
  | { kind: "emergency"; id: string; contacts: EmergencyContact[] }
  | { kind: "memo"; id: string; text: string }
  | { kind: "sources"; id: string; sources: Source[]; checkedAt: string }
  | {
      kind: "error";
      id: string;
      code: ClientErrorCode;
      message: string | null;
      retryable: boolean;
    };

export interface GuideState {
  availability: GuideAvailability;
  phase: TripPhase | null;
  /** 新しい順 */
  notices: GuideNotice[];
  proposals: GuideProposal[];
  memo: GuideMemoItem[];
  entries: GuideEntry[];
  /** 返答を受け取っている最中か */
  streaming: boolean;
  /** 「もう一度送る」で送り直す発言 */
  lastMessage: string | null;
  /** 発言の通し番号（会話の記録の ID に使う） */
  turn: number;
  /** ガイドが駆け寄って報告している通知 */
  report: string | null;
  /** もう報告した通知（同じ通知を2度報告しない） */
  reported: string[];
  spot: GuideSpot;
  /** 旗で案内している屋台。seq が変わるたびに、3D の旅人がそこへ歩く */
  lead: { stall: GuideStall; seq: number } | null;
  /** 開いている屋台 */
  openStall: GuideStall | null;
  /** 屋台の一覧を開いているか（2D を主にしているときは、いつも出す） */
  listOpen: boolean;
  /** 会話の窓を出しているか */
  dialogueOpen: boolean;
}

export const INITIAL_GUIDE: GuideState = Object.freeze({
  availability: "idle",
  phase: null,
  notices: [],
  proposals: [],
  memo: [],
  entries: [],
  streaming: false,
  lastMessage: null,
  turn: 0,
  report: null,
  reported: [],
  spot: "home",
  lead: null,
  openStall: null,
  listOpen: false,
  dialogueOpen: false,
}) as GuideState;

export function unreadNotices(guide: { notices: readonly GuideNotice[] }): GuideNotice[] {
  return guide.notices.filter((notice) => notice.readAt === null);
}

/** 提灯を灯す屋台。未読の通知がある屋台だけ（通知の中身から決める） */
export function litStalls(guide: { notices: readonly GuideNotice[] }): GuideStall[] {
  const lit = new Set(unreadNotices(guide).map((notice) => noticeStall(notice.content)));
  return GUIDE_STALLS.filter((stall) => lit.has(stall));
}

export function noticesOfStall(
  guide: { notices: readonly GuideNotice[] },
  stall: GuideStall,
): GuideNotice[] {
  return guide.notices.filter((notice) => noticeStall(notice.content) === stall);
}

/** 報告している通知 */
export function reportedNotice(guide: {
  notices: readonly GuideNotice[];
  report: string | null;
}): GuideNotice | null {
  return guide.notices.find((notice) => notice.id === guide.report) ?? null;
}

/**
 * まだ報告していない未読の通知があれば、ガイドが旅人へ駆け寄って報告する。
 * 返答の途中と、別の通知を報告している間は待つ
 */
export function advanceReport(guide: GuideState): GuideState {
  if (guide.streaming || guide.report !== null) return guide;
  const next = unreadNotices(guide).find((notice) => !guide.reported.includes(notice.id));
  if (next === undefined) return guide;
  return {
    ...guide,
    report: next.id,
    reported: [...guide.reported, next.id],
    spot: "player",
    dialogueOpen: true,
  };
}

/** POST /api/guide/state の応答を入れる。手元で読んだ通知は、読んだままにする */
export function applyGuideState(guide: GuideState, response: GuideStateResponse): GuideState {
  const readHere = new Map(
    guide.notices.flatMap((notice) =>
      notice.readAt === null ? [] : [[notice.id, notice.readAt] as const],
    ),
  );
  return advanceReport({
    ...guide,
    availability: "ready",
    phase: response.phase,
    notices: response.notices.map((notice) => ({
      ...notice,
      readAt: notice.readAt ?? readHere.get(notice.id) ?? null,
    })),
    proposals: response.proposals,
    memo: response.memo,
  });
}

/** 通知を読んだことにする。その屋台の提灯は消える。報告の途中の通知なら、報告も終える */
export function markRead(guide: GuideState, ids: readonly string[], at: string): GuideState {
  if (ids.length === 0) return guide;
  return {
    ...guide,
    notices: guide.notices.map((notice) =>
      ids.includes(notice.id) && notice.readAt === null ? { ...notice, readAt: at } : notice,
    ),
    report: guide.report !== null && ids.includes(guide.report) ? null : guide.report,
  };
}

/** 発言を送り始める。送り直しのときは、自分の発言を重ねない */
export function beginGuideTurn(guide: GuideState, message: string, retry: boolean): GuideState {
  const turn = guide.turn + 1;
  const kept = guide.entries.filter((entry) => entry.kind !== "error");
  return {
    ...guide,
    turn,
    streaming: true,
    lastMessage: message,
    dialogueOpen: true,
    spot: "player",
    entries: retry ? kept : [...kept, { kind: "user", id: `user-${turn}`, text: message }],
  };
}

function upsertGuideText(entries: GuideEntry[], id: string, text: string): GuideEntry[] {
  const found = entries.some((entry) => entry.kind === "guide" && entry.id === id);
  if (!found) return [...entries, { kind: "guide", id, text, streaming: true }];
  return entries.map((entry) =>
    entry.kind === "guide" && entry.id === id ? { ...entry, text: entry.text + text } : entry,
  );
}

const closeText = (entries: GuideEntry[]): GuideEntry[] =>
  entries.map((entry) =>
    entry.kind === "guide" && entry.streaming ? { ...entry, streaming: false } : entry,
  );

/** ガイドの SSE の1件を、ストアの更新に変える */
export function applyGuideEvent(guide: GuideState, event: GuideSseEvent): GuideState {
  const prefix = `t${guide.turn}`;
  switch (event.type) {
    case "guide.tool.start":
      return {
        ...guide,
        entries: [
          ...guide.entries,
          {
            kind: "tool",
            id: `${prefix}-${event.data.toolCallId}`,
            tool: event.data.tool,
            bubble: event.data.bubble,
            running: true,
            ok: true,
          },
        ],
      };
    case "guide.tool.end":
      return {
        ...guide,
        entries: guide.entries.map((entry) =>
          entry.kind === "tool" && entry.id === `${prefix}-${event.data.toolCallId}`
            ? { ...entry, bubble: event.data.bubble, running: false, ok: event.data.ok }
            : entry,
        ),
      };
    case "guide.emergency":
      // 緊急の連絡先は、ガイドの文より前に並ぶ（サーバーが先に送る）
      return {
        ...guide,
        dialogueOpen: true,
        entries: [
          ...guide.entries,
          { kind: "emergency", id: `${prefix}-emergency`, contacts: event.data.contacts },
        ],
      };
    case "guide.notice": {
      const { notice } = event.data;
      const others = guide.notices.filter((other) => other.id !== notice.id);
      // 会話でもう一度知らされても、手元で読んだ通知は未読に戻さない
      const readAt = guide.notices.find((other) => other.id === notice.id)?.readAt ?? notice.readAt;
      return { ...guide, notices: [{ ...notice, readAt }, ...others] };
    }
    case "guide.proposal": {
      const { proposal } = event.data;
      const others = guide.proposals.filter((other) => other.id !== proposal.id);
      return { ...guide, proposals: [proposal, ...others] };
    }
    case "guide.memo": {
      const { item } = event.data;
      const others = guide.memo.filter((other) => other.id !== item.id);
      return {
        ...guide,
        memo: [...others, item],
        entries: [
          ...guide.entries,
          { kind: "memo", id: `${prefix}-memo-${item.id}`, text: item.text },
        ],
      };
    }
    case "message.delta":
      return {
        ...guide,
        entries: upsertGuideText(
          guide.entries,
          `${prefix}-${event.data.messageId}`,
          event.data.text,
        ),
      };
    case "guide.sources":
      return {
        ...guide,
        entries: [
          ...guide.entries,
          {
            kind: "sources",
            id: `${prefix}-sources-${event.data.messageId}`,
            sources: event.data.sources,
            checkedAt: event.data.checkedAt,
          },
        ],
      };
    case "error":
      return {
        ...guide,
        entries: [
          ...guide.entries,
          {
            kind: "error",
            id: `${prefix}-error`,
            code: event.data.code,
            message: event.data.message,
            retryable: event.data.retryable,
          },
        ],
      };
    case "guide.done":
      return advanceReport({
        ...guide,
        streaming: false,
        phase: event.data.phase,
        entries: closeText(guide.entries),
      });
  }
}

/** 返答を受け取れないまま閉じたときの片付け。error があれば会話の窓に出す */
export function endGuideTurn(guide: GuideState, error: ClientError | null): GuideState {
  const closed = { ...guide, streaming: false, entries: closeText(guide.entries) };
  if (error === null) return advanceReport(closed);
  return advanceReport({
    ...closed,
    entries: [
      ...closed.entries,
      {
        kind: "error",
        id: `t${guide.turn}-error`,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    ],
  });
}

/** 会話の窓に出す、いまのひとこと */
export type GuideLine =
  | { kind: "greeting" }
  | { kind: "unavailable" }
  | { kind: "report"; notice: GuideNotice }
  | { kind: "waiting" }
  | { kind: "tool"; bubble: string }
  | { kind: "guide"; id: string; text: string; streaming: boolean }
  | { kind: "error"; code: ClientErrorCode; message: string | null; retryable: boolean };

export function guideLine(guide: GuideState): GuideLine {
  const notice = reportedNotice(guide);
  if (notice !== null) return { kind: "report", notice };
  for (let index = guide.entries.length - 1; index >= 0; index--) {
    const entry = guide.entries[index];
    if (entry === undefined) continue;
    if (entry.kind === "user") return guide.streaming ? { kind: "waiting" } : { kind: "greeting" };
    if (entry.kind === "guide") {
      return { kind: "guide", id: entry.id, text: entry.text, streaming: entry.streaming };
    }
    if (entry.kind === "error") {
      return {
        kind: "error",
        code: entry.code,
        message: entry.message,
        retryable: entry.retryable,
      };
    }
    if (entry.kind === "tool" && entry.running) return { kind: "tool", bubble: entry.bubble };
  }
  return guide.availability === "unavailable" ? { kind: "unavailable" } : { kind: "greeting" };
}

/** いまの発言への緊急の連絡先。文より先に、いちばん上に出す */
export function currentEmergency(guide: GuideState): EmergencyContact[] {
  const entry = guide.entries.findLast((item) => item.kind === "emergency");
  if (entry?.kind !== "emergency") return [];
  const lastUser = guide.entries.findLastIndex((item) => item.kind === "user");
  return guide.entries.indexOf(entry) > lastUser ? entry.contacts : [];
}
