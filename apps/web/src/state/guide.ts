import {
  type DecideProposalResponse,
  GUIDE_STALLS,
  type GuideMemoItem,
  type GuideNotice,
  type GuideProposal,
  type GuideSseEvent,
  type GuideStall,
  type GuideStateResponse,
  type GuideToolName,
  type ItineraryDiff,
  noticeStall,
  type Source,
  type TripChange,
  type TripPhase,
  type TripWatch,
} from "@matsuri-ikoka/schema";
import type { ClientErrorCode } from "./types";

// しおりのあとの縁日の通りとガイドの状態。正しい状態はここ（ストアの guide）だけが持つ。
// 画面の 2D と 3D は、どちらもこの形を読むだけにする。SSE のイベントは applyGuideEvent でこの形の更新に変える。

/**
 * ガイドと話せるか。idle まだ確かめていない / loading 確かめている / ready 話せる /
 * unavailable この環境や相談では話せない（屋台の情報は読める）/ failed 一時的に読めない（もう一度試せる）
 */
export type GuideAvailability = "idle" | "loading" | "ready" | "unavailable" | "failed";

/** ガイドが立つ場所。home 通りの入り口 / player 旅人のそば / それ以外は、その屋台の脇 */
export type GuideSpot = "home" | "player" | GuideStall;

/** ガイドの相談のエラー。guide_gone は相談や旅が切れて、この相談では続けられないとき */
export type GuideErrorCode = ClientErrorCode | "guide_gone";

export interface GuideError {
  code: GuideErrorCode;
  message: string | null;
  retryable: boolean;
}

/** この相談では続けられない（サーバーの一文は使わず、画面の辞書の文を出す） */
export const GUIDE_GONE: GuideError = Object.freeze({
  code: "guide_gone",
  message: null,
  retryable: false,
});

export type GuideEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "guide"; id: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; tool: GuideToolName; bubble: string; running: boolean; ok: boolean }
  | { kind: "memo"; id: string; text: string }
  | { kind: "sources"; id: string; sources: Source[]; checkedAt: string }
  | {
      kind: "error";
      id: string;
      code: GuideErrorCode;
      message: string | null;
      retryable: boolean;
    };

/**
 * 決める操作の結果。applied 承認して新しい版になった / rejected 断った / reverted 前の版に戻した /
 * stale 提案のあとに旅程が変わった / expired 期限が過ぎた / unknown 適用できたか確かめられない /
 * failed 送れなかった（もう一度試せる）
 */
export type GuideOutcome =
  | { kind: "applied"; diff: ItineraryDiff }
  | { kind: "reverted"; diff: ItineraryDiff }
  | { kind: "rejected" }
  | { kind: "stale" }
  | { kind: "expired" }
  | { kind: "unknown" }
  | { kind: "failed" };

/** いま送っている決める操作。提案は、その ID */
export type GuideBusy = { kind: "watch" } | { kind: "revert" } | { kind: "proposal"; id: string };

export interface GuideState {
  availability: GuideAvailability;
  phase: TripPhase | null;
  /** いまの旅程の版（サーバーの応答から） */
  version: number | null;
  /** 見回りの依頼。頼んでいなければ null */
  watch: TripWatch | null;
  /** この環境で見回りが動くか（サーバーの応答から）。動かなければ、見回りの切り替えを出さない */
  watchAvailable: boolean;
  /** 送っている決める操作（同じ操作を重ねて送らない） */
  busy: GuideBusy | null;
  /** 最後の決める操作の結果 */
  outcome: GuideOutcome | null;
  /** 承認のあとに戻せる版（承認する前の版）。戻したら null */
  revertTo: number | null;
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
  /** 旗で案内している屋台。seq が変わるたびに、3D の旅人がそこへ歩く。done は屋台を開いたあと */
  lead: { stall: GuideStall; seq: number; done: boolean } | null;
  /** 3D の通りを描けていて、旅人が歩けるか。描けていなければ、案内は歩かずに屋台を開く */
  sceneReady: boolean;
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
  version: null,
  watch: null,
  watchAvailable: false,
  busy: null,
  outcome: null,
  revertTo: null,
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
  sceneReady: false,
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
 * 返答の途中、別の通知を報告している間、屋台を開いている間は待つ
 */
export function advanceReport(guide: GuideState): GuideState {
  if (guide.streaming || guide.report !== null || guide.openStall !== null) return guide;
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
  const next: GuideState = {
    ...guide,
    availability: "ready",
    phase: response.phase,
    version: response.version,
    watch: response.watch,
    watchAvailable: response.watchAvailable,
    // 別の画面で版が増えていたら、この画面で承認した変更の「戻す」は出さない
    revertTo: guide.version === null || guide.version === response.version ? guide.revertTo : null,
    notices: response.notices.map((notice) => ({
      ...notice,
      readAt: notice.readAt ?? readHere.get(notice.id) ?? null,
    })),
    proposals: response.proposals,
    memo: response.memo,
  };
  // 話している最中なら、読んでいる返事を報告で隠さない（提灯だけ灯して、次の操作まで待つ）
  return guide.dialogueOpen && guide.entries.length > 0 ? next : advanceReport(next);
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

/** 手元の未読の数がサーバーの数と違うか（見回りが上限で古い通知を押し出すと、違ってくる） */
export function unreadDiffers(guide: GuideState, serverUnread: number): boolean {
  return unreadNotices(guide).length !== serverUnread;
}

/** 決める操作を送り始める。前の結果は消す */
export function beginGuideAction(guide: GuideState, busy: GuideBusy): GuideState {
  return { ...guide, busy, outcome: null };
}

/** 見回りの依頼の応答を入れる */
export function applyWatch(guide: GuideState, watch: TripWatch): GuideState {
  return { ...guide, busy: null, watch };
}

/** 版が増えた（承認か、前の版に戻した） */
function changed(guide: GuideState, change: TripChange): GuideState {
  return {
    ...guide,
    version: change.itinerary.version,
    // 提案は元の版が今の版と違うので、もう承認できない
    proposals: guide.proposals.filter(
      (proposal) => proposal.baseVersion === change.itinerary.version,
    ),
  };
}

/** 提案の承認・却下の応答を入れる */
export function applyDecision(
  guide: GuideState,
  proposalId: string,
  response: DecideProposalResponse,
): GuideState {
  const without = guide.proposals.filter((proposal) => proposal.id !== proposalId);
  const done = { ...guide, busy: null };
  switch (response.outcome) {
    case "applied":
      return {
        ...changed(done, response.change),
        outcome: { kind: "applied", diff: response.change.diff },
        revertTo: response.change.diff.fromVersion,
      };
    case "rejected":
      return { ...done, proposals: without, outcome: { kind: "rejected" } };
    case "stale":
      return {
        ...done,
        proposals: without,
        version: response.currentVersion,
        outcome: { kind: "stale" },
      };
    case "expired":
      return { ...done, proposals: without, outcome: { kind: "expired" } };
    case "unknown":
      // 自動でやり直さない。提案は残し、読み直した状態を見せる
      return { ...done, outcome: { kind: "unknown" } };
  }
}

/** 前の版に戻した応答を入れる */
export function applyRevert(guide: GuideState, change: TripChange): GuideState {
  return {
    ...changed({ ...guide, busy: null }, change),
    outcome: { kind: "reverted", diff: change.diff },
    revertTo: null,
  };
}

/** 決める操作を送れなかった。文はサーバーの文でなく、画面の辞書の文を出す（画面の言葉に合わせる） */
export function failGuideAction(guide: GuideState): GuideState {
  return { ...guide, busy: null, outcome: { kind: "failed" } };
}

/** 発言を送り始める。送り直しのときは、自分の発言を重ねない。報告は閉じて、返事を見せる */
export function beginGuideTurn(guide: GuideState, message: string, retry: boolean): GuideState {
  const turn = guide.turn + 1;
  const kept = guide.entries.filter((entry) => entry.kind !== "error");
  return {
    ...guide,
    turn,
    streaming: true,
    report: null,
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

/** 受け取っている途中の文を閉じる */
export const closeText = (entries: GuideEntry[]): GuideEntry[] =>
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
    case "error": {
      // 形の誤りで送り直せないのは、相談や旅が切れたとき（サーバーの区別は code に出ない）
      const gone = event.data.code === "bad_request" && !event.data.retryable;
      const error: GuideError = gone ? GUIDE_GONE : event.data;
      return {
        ...guide,
        availability: gone ? "unavailable" : guide.availability,
        entries: [...guide.entries, { kind: "error", id: `${prefix}-error`, ...error }],
      };
    }
    case "guide.done":
      // 読んでいる返事を報告で隠さない。届いた通知は提灯を灯し、次の操作まで待つ
      return {
        ...guide,
        streaming: false,
        phase: event.data.phase,
        entries: closeText(guide.entries),
      };
  }
}

/** 返答を受け取れないまま閉じたときの片付け。error があれば会話の窓に出す（もう届いていれば重ねない） */
export function endGuideTurn(guide: GuideState, error: GuideError | null): GuideState {
  const closed = { ...guide, streaming: false, entries: closeText(guide.entries) };
  const id = `t${guide.turn}-error`;
  if (error === null || closed.entries.some((entry) => entry.id === id)) return closed;
  return { ...closed, entries: [...closed.entries, { kind: "error", id, ...error }] };
}

/** 会話の窓に出す、いまのひとこと */
export type GuideLine =
  | { kind: "greeting" }
  | { kind: "unavailable" }
  | { kind: "report"; notice: GuideNotice }
  | { kind: "waiting" }
  | { kind: "tool"; tool: GuideToolName; bubble: string }
  | { kind: "guide"; id: string; text: string; streaming: boolean }
  | {
      kind: "error";
      code: GuideErrorCode;
      message: string | null;
      retryable: boolean;
      /** 失敗の前に届いていた文。隠さない */
      said: string | null;
    };

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
      const said = guide.entries
        .slice(0, index)
        .findLast((item) => item.kind === "user" || item.kind === "guide");
      return {
        kind: "error",
        code: entry.code,
        message: entry.message,
        retryable: entry.retryable,
        said: said?.kind === "guide" ? said.text : null,
      };
    }
    if (entry.kind === "tool" && entry.running) {
      return { kind: "tool", tool: entry.tool, bubble: entry.bubble };
    }
  }
  return guide.availability === "unavailable" ? { kind: "unavailable" } : { kind: "greeting" };
}
