import {
  decodeGuideSseEvent,
  decodeSseEvent,
  type FestivalCandidate,
  type FestivalSearchNext,
  type FestivalSearchResult,
  type GuideSseEvent,
  type GuideStall,
  MAX_MESSAGE_LENGTH,
  MarkNoticesReadResponseSchema,
  type Preferences,
  type SearchRetry,
  type SearchSuggestion,
  type SseEvent,
  type SseMessage,
  type TripAnchor,
  type TripChange,
} from "@matsuri-ikoka/schema";
import { createStore, type StoreApi } from "zustand/vanilla";
import { MESSAGES } from "../i18n";
import { isSendablePasscode } from "../transport/server";
import type { ChatTransport, FestivalSource, OnSseMessage } from "../transport/types";
import { TransportError, toClientError } from "../transport/types";
import {
  anchorMessage,
  anchorPlanRequest,
  anchorToSend,
  applyPreview,
  beginAnchoredHearing,
  beginPreview,
  failPreview,
  leaveAnchor,
} from "./anchorTrip";
import {
  type AnchorPreview,
  type ConsultAnswers,
  type ConsultEntry,
  type ConsultQuestion,
  type ConsultState,
  type ConsultStep,
  chooseEntry,
  composeConsultMessage,
  INITIAL_CONSULT,
  leaveHearing,
  pickAnswer,
  setAnswerText,
  todayInJapan,
} from "./consult";
import { clientError } from "./errors";
import { applyEvent, verifyFromItinerary } from "./events";
import {
  anchorOf,
  applySearchResponse,
  backToResults,
  beginMore,
  beginNext,
  beginSearch,
  chooseResult,
  editConditions,
  type FestivalSearchAnswers,
  type FestivalSearchState,
  type FestivalSearchStep,
  failSearch,
  finishHere,
  INITIAL_FESTIVAL_SEARCH,
  isSearching,
  returnToResults,
  searchRequest,
} from "./festivalSearch";
import {
  advanceReport,
  applyDecision,
  applyGuideEvent,
  applyGuideState,
  applyRevert,
  applyWatch,
  beginGuideAction,
  beginGuideTurn,
  closeText,
  endGuideTurn,
  failGuideAction,
  GUIDE_GONE,
  type GuideBusy,
  type GuideError,
  type GuideState,
  markRead,
  noticesOfStall,
  unreadDiffers,
} from "./guide";
import { initialData } from "./initial";
import { quizById } from "./quizBank";
import { shioriReady } from "./selectors";
import {
  addError,
  answerQuiz,
  beginTurn,
  changePreference,
  endTurn,
  passcodeAccepted,
  requirePasscode,
  resetForNewSession,
  setCandidatesOpen,
  settleStaff,
  type TurnStart,
} from "./transitions";
import type { AppData, ClientError, Locale, PanelTab } from "./types";
import { shuffleDeck } from "./waiting";

// 画面の正しい状態を持つストア。通信の口から届いた SSE の1件を、ここで1か所で検証し、
// events.ts の純粋な関数でストアの更新に変える。部品はイベントを直接受けない。

/** スタッフが持ち場から戻るのにかける時間 */
export const STAFF_RETURN_MS = 1_200;
/** 「旅のしおり完成」の演出の長さ */
export const CELEBRATION_MS = 1_500;
/** コンシェルジュが帽子をかぶって旗を振り、店の外へ先導する長さ */
export const LEAD_OUT_MS = 2_400;

export interface AppActions {
  /** 店に入り、相談を始める */
  enterShop(): Promise<void>;
  /** 発言を送る */
  send(text: string): Promise<void>;
  /** 最後の発言（またはこだわりの切り替え）を送り直す */
  retry(): Promise<void>;
  /** 候補カードから祭りを選ぶ */
  chooseCandidate(candidate: FestivalCandidate): Promise<void>;
  /** 見つからなかったときの次の手を選ぶ。変えた条件で探し直す（条件を選び直すなら聞き取りに戻る） */
  chooseSuggestion(suggestion: SearchSuggestion): Promise<void>;
  /** こだわりを切り替える。旅程があれば、旅程係が組み直す */
  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void>;
  /** 相談を最初からやり直す */
  restart(): Promise<void>;
  /** 合言葉を入れる。相談を始める前なら始め、途中なら断られた発言を送り直す */
  submitPasscode(passcode: string): Promise<void>;
  setDraft(text: string): void;
  setTab(tab: PanelTab): void;
  setLocale(locale: Locale): void;
  setSound(on: boolean): void;
  setDrawer(open: boolean): void;
  setCandidatesOpen(open: boolean): void;
  openShiori(): void;
  closeShiori(): void;
  /** 会話の窓を出す・しまう */
  setDialogue(open: boolean): void;
  /** 選んで進める聞き取りの段階を移る。editing は確認の画面から直しに行くとき */
  setConsultStep(step: ConsultStep, editing?: boolean): void;
  /** 聞き取りの選択肢を選ぶ（いくつでも選べる項目では付け外し） */
  pickConsult(question: ConsultQuestion, pick: string): void;
  /** 聞き取りの「その他」の自由記述・出発の駅・ひとことを書く */
  setConsultText(question: ConsultQuestion, text: string): void;
  /** 聞き取りの答えを、consult.ts の関数で変える（人数・期間・金額など） */
  editConsult(edit: (answers: ConsultAnswers) => ConsultAnswers): void;
  /** 祭りを固定した聞き取りの状態を、anchorTrip.ts の関数で変える（行く日・泊数・期間） */
  editAnchoredHearing(edit: (consult: ConsultState) => ConsultState): void;
  /** いまの答えで旅の組み立てを確かめる。同じ答えの結果があれば読み直さない */
  loadAnchorPreview(): Promise<void>;
  /** 選んだ内容を1つの発言にまとめて送る */
  submitConsult(): Promise<void>;
  /** 聞き取りを選び直す */
  reopenConsult(): void;
  /** 相談の入口を選ぶ（祭りから探す / 旅行計画から探す） */
  chooseConsultEntry(entry: ConsultEntry): void;
  /** はじめからやり直す。選んだ内容を消して、入口へ戻る */
  startConsultOver(): void;
  /** 聞き取りの最初の段階から戻る（入口か、決めた祭りのところへ） */
  leaveHearing(): void;
  /** 祭りから探す相談の段階を移る */
  setFestivalStep(step: FestivalSearchStep): void;
  /** 祭りから探す相談の答えを、festivalSearch.ts の関数で変える */
  editFestivalAnswers(edit: (answers: FestivalSearchAnswers) => FestivalSearchAnswers): void;
  /** 答えた条件で祭りを探す */
  searchFestivals(): Promise<void>;
  /** 別の祭りを提案してもらう */
  moreFestivals(): Promise<void>;
  /** 次の手を選ぶ。変えた条件で探す（条件を選び直す手は聞き取りに戻る） */
  chooseFestivalNext(next: FestivalSearchNext): Promise<void>;
  /** 条件を選び直す。step を渡すと、その段階から */
  editFestivalConditions(step?: FestivalSearchStep): void;
  setFestivalResultsOpen(open: boolean): void;
  /** 結果から祭りを選ぶ */
  chooseFestival(result: FestivalSearchResult): void;
  /** 「ほかの祭りを見る」 */
  backToFestivalResults(): void;
  /** 「ここで終わる」 */
  finishFestivalSearch(): void;
  /** 「旅行計画を作成する」：選んだ祭りを残して、旅行計画の聞き取りへ進む */
  planFestivalTrip(): void;
  /** 祭りを決めて送ったあとに、祭りの結果へ戻る（中止と分かった祭りは一覧から外す） */
  returnToFestivalResults(): void;
  /** はじめての操作の案内を閉じる */
  dismissTutorial(): void;
  /** のれんをくぐって店の外へ出る（相談はそのまま残す） */
  leaveShop(): void;
  /** ガイドと店の外へ出る。animate は 3D の店内を出しているときで、先導の動きのあとに通りへ出る */
  leaveWithGuide(animate?: boolean): void;
  /** 縁日の通りから店内へ戻る */
  returnToShop(): Promise<void>;
  /** ガイドの通知と手帳を読む（読み込み済みなら、force のときだけ読み直す） */
  loadGuide(force?: boolean): Promise<void>;
  /** ガイドに発言を送る */
  sendGuide(text: string): Promise<void>;
  /** 最後の発言をガイドに送り直す */
  retryGuide(): Promise<void>;
  /** 屋台を開く。その屋台の通知は読んだことになり、提灯が消える */
  openStall(stall: GuideStall): void;
  closeStall(): void;
  setStallList(open: boolean): void;
  /** ガイドの会話の窓を出す・しまう。出すと、ガイドが旅人のそばへ来る */
  setGuideDialogue(open: boolean): void;
  /** ガイドが旗でその屋台へ案内する。3D の旅人が歩けるなら歩いて着いてから、歩けなければすぐに屋台を開く */
  leadToStall(stall: GuideStall): void;
  /** 3D の通りを描けたか。描けなくなったら、歩いている途中の案内は屋台を開いて終える */
  setStreetScene(ready: boolean): void;
  /** 報告を「あとで」にする。次の未報告の通知があれば、続けて報告する */
  dismissReport(): void;
  /** 見回りを始める・止める */
  setGuideWatch(action: "start" | "stop"): Promise<void>;
  /** 組み直しの提案を承認する・断る。承認すると旅程が新しい版になる */
  decideProposal(proposalId: string, decision: "approve" | "reject"): Promise<void>;
  /** 承認した変更を、承認する前の版に戻す。戻した旅程も新しい版になる */
  revertGuideChange(): Promise<void>;
  /** 残した旅を開いて、縁日の通りに戻る。開けなければ false */
  openSavedTrip(tripId: string): Promise<boolean>;
  nextTrivia(): void;
  prevTrivia(): void;
  /** 豆知識のあいだに出したクイズに答える */
  answerQuiz(quizId: string, choice: number): void;
  /** 祭りのデータを読み込む（読み込み済みのものは読まない） */
  ensureFestivals(ids: readonly string[]): Promise<void>;
}

export type AppState = AppData & { actions: AppActions };
export type AppStore = StoreApi<AppState>;

export interface StoreDeps {
  transport: ChatTransport;
  festivals: FestivalSource;
  locale?: Locale;
  /** はじめての操作の案内を、前に見終えているか */
  tutorialSeen?: boolean;
  /** 日本の今日（YYYY-MM-DD）。「今週末」などの日付の計算に使う */
  today?: () => string;
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createAppStore(deps: StoreDeps): AppStore {
  const { transport, festivals } = deps;
  const random = deps.random ?? Math.random;
  const today = deps.today ?? (() => todayInJapan());
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let controller: AbortController | null = null;
  let sessionController: AbortController | null = null;
  let searchController: AbortController | null = null;
  let previewController: AbortController | null = null;
  let guideController: AbortController | null = null;
  let guideStateController: AbortController | null = null;
  const timers = new Set<unknown>();

  return createStore<AppState>()((set, get) => {
    const update = (change: (state: AppData) => AppData) => set((state) => change(state));

    const later = (ms: number, callback: () => void) => {
      const handle = setTimer(() => {
        timers.delete(handle);
        callback();
      }, ms);
      timers.add(handle);
    };

    const clearTimers = () => {
      for (const handle of timers) {
        clearTimer(handle);
      }
      timers.clear();
    };

    const afterEvent = (event: SseEvent, before: AppData) => {
      if (event.type === "tool.end" && event.data.candidates !== undefined) {
        void get().actions.ensureFestivals(event.data.candidates.map((c) => c.festivalId));
      }
      if (event.type === "itinerary.updated") {
        void get().actions.ensureFestivals([event.data.itinerary.mainFestivalId]);
      }
      if (event.type === "done") {
        later(STAFF_RETURN_MS, () => update(settleStaff));
      }
      if (get().ui.celebrating && !before.ui.celebrating) {
        later(CELEBRATION_MS, () =>
          update((state) => ({ ...state, ui: { ...state.ui, celebrating: false } })),
        );
      }
    };

    /** 届いた SSE の1件を検証し、ストアの更新に変える */
    const receive: OnSseMessage = (message: SseMessage) => {
      let event: SseEvent;
      try {
        event = decodeSseEvent(message);
      } catch {
        update((state) => addError(state, clientError("invalid_event")));
        return;
      }
      const before = get();
      try {
        update((state) => applyEvent(state, event));
        afterEvent(event, before);
      } catch (caught) {
        // 画面の側の処理の失敗を、通信の切断として扱わない（ここで投げると、受け取りが止まる）
        console.error(`[sse] ${event.type} の反映に失敗しました`, caught);
      }
    };

    const runStream = async (
      start: TurnStart,
      open: (onMessage: OnSseMessage, signal: AbortSignal) => Promise<void>,
    ) => {
      update((state) => beginTurn(state, start));
      const current = new AbortController();
      controller = current;
      let error: ClientError | null = null;
      try {
        await open(receive, current.signal);
      } catch (caught) {
        error = toClientError(caught);
      }
      if (current.signal.aborted) {
        return;
      }
      if (!get().session.sawDone && (error === null || error.code === "connection_lost")) {
        // done が届かないまま閉じた。サーバーが止まっているのか、接続だけが切れたのかを確かめて伝える
        const reachable = (await transport.checkServer?.()) ?? true;
        if (current.signal.aborted) {
          return;
        }
        error = clientError(reachable ? "connection_lost" : "server_unreachable");
      }
      controller = null;
      const sawDone = get().session.sawDone;
      if (error?.code === "session_lost") {
        // サーバーが相談を覚えていない（再起動など）。新しい相談を自動で始め、送り直せるようにする
        update((state) =>
          resetForNewSession({ ...state, session: { ...state.session, streaming: false } }),
        );
        later(STAFF_RETURN_MS, () => update(settleStaff));
        await startSession();
        return;
      }
      const failure = error;
      update((state) => {
        const ended = endTurn(state, failure);
        // 合言葉で断られたら、聞き直す。入れ直すと、断られた発言を送り直す
        return failure?.code === "unauthorized"
          ? requirePasscode(ended, transport.hasPasscode?.() ?? false)
          : passcodeAccepted(ended);
      });
      if (!sawDone) {
        later(STAFF_RETURN_MS, () => update(settleStaff));
      }
    };

    const startSession = async () => {
      sessionController?.abort();
      const current = new AbortController();
      sessionController = current;
      update((state) => ({ ...state, session: { ...state.session, status: "opening" } }));
      void festivals.initial().then((list) => {
        if (current.signal.aborted) {
          return;
        }
        update((state) => ({
          ...state,
          festivals: {
            ...state.festivals,
            ...Object.fromEntries(list.map((festival) => [festival.id, festival])),
          },
          festivalLoad: {
            ...state.festivalLoad,
            ...Object.fromEntries(list.map((festival) => [festival.id, "loaded" as const])),
          },
        }));
      });
      try {
        const id = await transport.startSession(current.signal);
        if (current.signal.aborted) {
          return;
        }
        const mode = transport.agentMode?.() ?? null;
        update((state) =>
          passcodeAccepted({ ...state, session: { ...state.session, id, mode, status: "ready" } }),
        );
      } catch (caught) {
        if (current.signal.aborted) {
          return;
        }
        const error = toClientError(caught);
        if (error.code === "unauthorized") {
          // 合言葉が要る（または違った）。始める前なら、店の入口で聞く
          const rejected = transport.hasPasscode?.() ?? false;
          update((state) =>
            requirePasscode(
              {
                ...state,
                session: { ...state.session, status: "closed" },
                ui: {
                  ...state.ui,
                  view: state.messages.length === 0 ? "storefront" : state.ui.view,
                },
              },
              rejected,
            ),
          );
          return;
        }
        update((state) =>
          addError({ ...state, session: { ...state.session, status: "failed" } }, error),
        );
      }
    };

    const sendChat = async (
      message: string,
      retry: boolean,
      search?: SearchRetry,
      anchor?: TripAnchor,
    ) => {
      const state = get();
      const sessionId = state.session.id;
      if (state.session.streaming || sessionId === null) {
        return;
      }
      const { preferences } = state;
      if (!state.ui.dialogueOpen) setUi({ dialogueOpen: true });
      const extra = {
        ...(search === undefined ? {} : { search }),
        ...(anchor === undefined ? {} : { anchor }),
      };
      await runStream(
        { kind: "chat", message, preferences, retry, ...extra },
        (onMessage, signal) =>
          transport.chat({ sessionId, message, preferences, ...extra }, onMessage, signal),
      );
    };

    const sendPreferences = async () => {
      const state = get();
      const sessionId = state.session.id;
      if (state.session.streaming || sessionId === null) {
        return;
      }
      const { preferences } = state;
      await runStream({ kind: "preferences", preferences }, (onMessage, signal) =>
        transport.updatePreferences({ sessionId, preferences }, onMessage, signal),
      );
    };

    const updateFestivalSearch = (change: (state: FestivalSearchState) => FestivalSearchState) =>
      update((state) => ({ ...state, festivalSearch: change(state.festivalSearch) }));

    /** いまの答えで検索を送り、結果か失敗をストアに入れる。相談が切れていたら、始め直して一度だけ送り直す */
    const runFestivalSearch = async (retried = false): Promise<void> => {
      const state = get();
      const sessionId = state.session.id;
      if (sessionId === null) {
        updateFestivalSearch((search) => failSearch(search, clientError("session_lost")));
        return;
      }
      const current = new AbortController();
      searchController = current;
      try {
        const response = await transport.searchFestivals(
          searchRequest(state.festivalSearch, sessionId),
          current.signal,
        );
        if (current.signal.aborted) return;
        updateFestivalSearch((search) => applySearchResponse(search, response));
        void actions.ensureFestivals(
          [...response.results, ...response.nearMatches.map((near) => near.result)].map(
            (result) => result.candidate.festivalId,
          ),
        );
      } catch (caught) {
        if (current.signal.aborted) return;
        const error = toClientError(caught);
        if (error.code === "session_lost" && !retried) {
          await startSession();
          if (current.signal.aborted) return;
          await runFestivalSearch(true);
          return;
        }
        updateFestivalSearch((search) => failSearch(search, error));
        if (error.code === "unauthorized") {
          update((data) => requirePasscode(data, transport.hasPasscode?.() ?? false));
        }
      }
    };

    /** 検索を始める。相談が始まる前や、探している最中は送らない */
    const startFestivalSearch = async (
      begin: (state: FestivalSearchState) => FestivalSearchState,
    ) => {
      const { session, festivalSearch } = get();
      if (session.status !== "ready" || session.streaming || isSearching(festivalSearch)) {
        return;
      }
      updateFestivalSearch(begin);
      await runFestivalSearch();
    };

    const setUi = (patch: Partial<AppData["ui"]>) =>
      update((state) => ({ ...state, ui: { ...state.ui, ...patch } }));

    const updateGuide = (change: (guide: GuideState) => GuideState) =>
      update((state) => ({ ...state, guide: change(state.guide) }));

    /** 通りへ出る。旅の祭りのデータと、ガイドの通知を読み始める */
    const arriveOnStreet = () => {
      update((state) => ({
        ...state,
        guide: { ...state.guide, spot: "home" },
        ui: {
          ...state.ui,
          view: "street",
          leadingOut: false,
          dialogueOpen: false,
          drawerOpen: false,
          candidatesOpen: false,
        },
      }));
      const id = get().itinerary.current?.mainFestivalId;
      if (id !== undefined) void get().actions.ensureFestivals([id]);
      // 通りへ出るたびに読み直す（留守の間に通知が増えている）
      void get().actions.loadGuide(true);
    };

    const runGuideTurn = async (message: string, retry: boolean) => {
      const { session, guide } = get();
      if (guide.streaming || session.id === null || transport.guideChat === undefined) {
        return;
      }
      const request = { sessionId: session.id, message };
      updateGuide((current) => beginGuideTurn(current, message, retry));
      const current = new AbortController();
      guideController = current;
      let sawDone = false;
      let serverUnread: number | null = null;
      let failure: GuideError | null = null;
      try {
        await transport.guideChat(
          request,
          (raw) => {
            let event: GuideSseEvent;
            try {
              event = decodeGuideSseEvent(raw);
            } catch {
              failure = clientError("invalid_event");
              return;
            }
            if (event.type === "guide.done") {
              sawDone = true;
              serverUnread = event.data.unreadNotices;
            }
            updateGuide((state) => applyGuideEvent(state, event));
          },
          current.signal,
        );
      } catch (caught) {
        if (current.signal.aborted) return;
        if (caught instanceof TransportError && caught.code === "unauthorized") {
          update((state) => requirePasscode(state, transport.hasPasscode?.() ?? false));
        }
        // 話せなくなった（相談の期限切れ・旅がない・ガイドの設定なし）
        if (caught instanceof TransportError && (caught.status === 404 || caught.status === 409)) {
          updateGuide((state) => ({ ...state, availability: "unavailable" }));
          failure = GUIDE_GONE;
        } else {
          failure = toClientError(caught);
        }
      }
      if (current.signal.aborted) return;
      guideController = null;
      if (!sawDone) {
        updateGuide((state) => endGuideTurn(state, failure ?? clientError("connection_lost")));
      }
      // 見回りが上限で古い通知を押し出すと、手元の未読の数が合わなくなる。サーバーの数に合わせる
      if (serverUnread !== null && unreadDiffers(get().guide, serverUnread)) {
        void get().actions.loadGuide(true);
      }
    };

    /** 版が増えた旅程を、店内の旅程と同じ形で入れる（差分を見せる） */
    const applyTripChange = (change: TripChange) =>
      update((state) => ({
        ...state,
        itinerary: {
          current: change.itinerary,
          previous: state.itinerary.current,
          diff: change.diff,
        },
        verify: verifyFromItinerary(change.itinerary),
      }));

    /**
     * ガイドの決める操作を送る。送っている間は、ほかの決める操作を重ねない。
     * 送れなければ結果に出して、もう一度押せるようにする（自動ではやり直さない）
     */
    const runGuideAction = async (busy: GuideBusy, send: (sessionId: string) => Promise<void>) => {
      const { session, guide } = get();
      if (session.id === null || guide.busy !== null) return;
      updateGuide((state) => beginGuideAction(state, busy));
      try {
        await send(session.id);
      } catch (caught) {
        if (get().session.id !== session.id) return;
        const message = caught instanceof TransportError ? caught.serverMessage : null;
        updateGuide((state) => failGuideAction(state, message));
        // 提案や版の状態が変わっているかもしれないので、読み直す
        void get().actions.loadGuide(true);
      }
    };

    /** ガイドとの通信を止める */
    const stopGuide = () => {
      guideController?.abort();
      guideController = null;
      guideStateController?.abort();
      guideStateController = null;
    };

    const actions: AppActions = {
      async enterShop() {
        setUi({ view: "shop" });
        if (get().session.status === "closed") {
          await startSession();
        }
      },

      async send(text) {
        const message = text.trim();
        if (message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
          return;
        }
        // 自分の言葉で書いて送ったら、選んで進める聞き取りはしまう（「選び直す」でまた開ける）
        if (get().consult.active && !get().session.streaming) {
          update((state) => ({ ...state, consult: { ...state.consult, active: false } }));
        }
        await sendChat(message, false);
      },

      async retry() {
        const state = get();
        if (state.session.streaming) {
          return;
        }
        if (state.session.status === "failed") {
          update((current) => ({
            ...current,
            messages: current.messages.map((entry) =>
              entry.kind === "error" ? { ...entry, resolved: true } : entry,
            ),
          }));
          await startSession();
          return;
        }
        if (state.session.lastWasPreferences) {
          await sendPreferences();
          return;
        }
        if (state.session.lastRequest !== null) {
          const { message, search, anchor } = state.session.lastRequest;
          await sendChat(message, true, search, anchor);
        }
      },

      async chooseCandidate(candidate) {
        setUi({ candidatesOpen: false });
        await sendChat(MESSAGES[get().ui.locale].candidates.chooseMessage(candidate.name), false);
      },

      async chooseSuggestion(suggestion) {
        setUi({ candidatesOpen: false });
        if (suggestion.retry === null || suggestion.message === null) {
          actions.reopenConsult();
          return;
        }
        await sendChat(suggestion.message, false, suggestion.retry);
      },

      async setPreference(key, value) {
        update((state) => changePreference(state, key, value));
        const state = get();
        if (state.itinerary.current !== null && !state.session.streaming) {
          await sendPreferences();
        }
      },

      async submitPasscode(value) {
        const passcode = value.trim();
        if (!isSendablePasscode(passcode)) {
          return;
        }
        transport.setPasscode?.(passcode);
        update(passcodeAccepted);
        // 通りでは、店内の前の発言を送り直さない（回数を使い、旅程が変わることがある）
        if (get().ui.view === "street") {
          const last = get().guide.entries.at(-1);
          if (last?.kind === "error" && last.code === "unauthorized") await actions.retryGuide();
          else await actions.loadGuide(true);
          return;
        }
        if (get().session.status !== "ready") {
          setUi({ view: "shop" });
          await startSession();
          return;
        }
        const { festivalSearch, consult } = get();
        if (consult.preview.error?.code === "unauthorized") {
          // 組み立ての確認で断られたなら、確かめ直す
          await actions.loadAnchorPreview();
          return;
        }
        if (festivalSearch.error?.code === "unauthorized") {
          // 祭り探しで断られたなら、探し直す
          await startFestivalSearch(festivalSearch.phase === "asking" ? beginSearch : beginMore);
          return;
        }
        await actions.retry();
      },

      async restart() {
        controller?.abort();
        controller = null;
        searchController?.abort();
        previewController?.abort();
        stopGuide();
        clearTimers();
        const { ui } = get();
        const fresh = initialData({ locale: ui.locale, tutorialSeen: ui.tutorialSeen });
        update(() => ({
          ...fresh,
          quiz: { ...fresh.quiz, deck: shuffleDeck(fresh.quiz.deck, random) },
          ui: { ...fresh.ui, soundOn: ui.soundOn, view: "shop" },
        }));
        await startSession();
      },

      setDraft(text) {
        setUi({ draft: text });
      },
      setTab(tab) {
        setUi({ tab });
      },
      setLocale(locale) {
        setUi({ locale });
      },
      setSound(on) {
        setUi({ soundOn: on });
      },
      setDrawer(open) {
        setUi({ drawerOpen: open });
      },
      setCandidatesOpen(open) {
        update((state) => setCandidatesOpen(state, open));
      },
      openShiori() {
        if (get().itinerary.current !== null) {
          const shioriReturn = get().ui.view === "street" ? "street" : "shop";
          setUi({ view: "shiori", shioriReturn, drawerOpen: false });
        }
      },
      closeShiori() {
        setUi({ view: get().ui.shioriReturn });
      },
      setDialogue(open) {
        setUi(open ? { dialogueOpen: true, tutorialSeen: true } : { dialogueOpen: false });
      },
      setConsultStep(step, editing = false) {
        update((state) => ({ ...state, consult: { ...state.consult, step, editing } }));
      },
      pickConsult(question, pick) {
        update((state) => ({
          ...state,
          consult: { ...state.consult, answers: pickAnswer(state.consult.answers, question, pick) },
        }));
      },
      setConsultText(question, text) {
        update((state) => ({
          ...state,
          consult: {
            ...state.consult,
            answers: setAnswerText(state.consult.answers, question, text),
          },
        }));
      },
      editConsult(edit) {
        update((state) => ({
          ...state,
          consult: { ...state.consult, answers: edit(state.consult.answers) },
        }));
      },
      async submitConsult() {
        const state = get();
        if (state.session.streaming || state.session.status !== "ready") {
          return;
        }
        const message = composeConsultMessage(
          state.consult.answers,
          MESSAGES[state.ui.locale].consult.wording,
          today(),
          anchorMessage(
            state.consult,
            state.festivalSearch.chosen?.candidate ?? null,
            state.session.id,
          ),
        );
        if (message === null) {
          return;
        }
        update((current) => ({ ...current, consult: { ...current.consult, active: false } }));
        await sendChat(message, false, undefined, anchorToSend(state.consult) ?? undefined);
      },
      editAnchoredHearing(edit) {
        update((state) => ({ ...state, consult: edit(state.consult) }));
      },
      async loadAnchorPreview() {
        const { consult, session } = get();
        if (session.id === null || session.status !== "ready") return;
        const request = anchorPlanRequest(consult, session.id);
        if (request === null) return;
        const key = JSON.stringify(request);
        const { preview } = consult;
        if (preview.key === key && (preview.status === "loading" || preview.status === "ready")) {
          return;
        }
        previewController?.abort();
        const current = new AbortController();
        previewController = current;
        const setPreview = (next: AnchorPreview) =>
          update((state) => ({ ...state, consult: { ...state.consult, preview: next } }));
        setPreview(beginPreview(key));
        try {
          const plan = await transport.previewFestivalTrip(request, current.signal);
          if (!current.signal.aborted) setPreview(applyPreview(key, plan));
        } catch (caught) {
          if (current.signal.aborted) return;
          const error = toClientError(caught);
          setPreview(failPreview(key, error));
          if (error.code === "unauthorized") {
            update((data) => requirePasscode(data, transport.hasPasscode?.() ?? false));
          }
        }
      },
      reopenConsult() {
        update((state) => ({
          ...state,
          consult: { ...state.consult, active: true, entry: "trip", step: "party", editing: false },
        }));
      },
      chooseConsultEntry(entry) {
        update((state) => ({ ...state, consult: chooseEntry(state.consult, entry) }));
      },
      startConsultOver() {
        searchController?.abort();
        previewController?.abort();
        update((state) => ({
          ...state,
          consult: { ...INITIAL_CONSULT, answers: {} },
          festivalSearch: { ...INITIAL_FESTIVAL_SEARCH },
        }));
      },
      leaveHearing() {
        previewController?.abort();
        update((state) => ({ ...state, consult: leaveHearing(state.consult) }));
      },
      setFestivalStep(step) {
        updateFestivalSearch((search) => ({ ...search, step, error: null }));
      },
      editFestivalAnswers(edit) {
        updateFestivalSearch((search) => ({ ...search, answers: edit(search.answers) }));
      },
      async searchFestivals() {
        await startFestivalSearch(beginSearch);
      },
      async moreFestivals() {
        if (get().festivalSearch.remaining > 0) await startFestivalSearch(beginMore);
      },
      async chooseFestivalNext(next) {
        const { conditions } = next;
        if (conditions === null) {
          actions.editFestivalConditions();
          return;
        }
        await startFestivalSearch((search) => beginNext(search, conditions));
      },
      editFestivalConditions(step) {
        searchController?.abort();
        updateFestivalSearch((search) => editConditions({ ...search, loadingMore: false }, step));
      },
      setFestivalResultsOpen(open) {
        updateFestivalSearch((search) => ({ ...search, resultsOpen: open }));
      },
      chooseFestival(result) {
        updateFestivalSearch((search) => chooseResult(search, result));
      },
      backToFestivalResults() {
        updateFestivalSearch(backToResults);
      },
      finishFestivalSearch() {
        updateFestivalSearch(finishHere);
      },
      planFestivalTrip() {
        const { chosen } = get().festivalSearch;
        if (chosen === null) return;
        update((state) => ({
          ...state,
          consult: beginAnchoredHearing(state.consult, anchorOf(chosen)),
        }));
        void actions.ensureFestivals([chosen.candidate.festivalId]);
      },
      returnToFestivalResults() {
        previewController?.abort();
        update((state) => {
          const { anchor, anchorCancelled } = state.consult;
          const cancelledId = anchorCancelled ? (anchor?.festivalId ?? null) : null;
          return {
            ...state,
            consult: leaveAnchor(state.consult),
            festivalSearch: returnToResults(state.festivalSearch, cancelledId),
            ui: { ...state.ui, candidatesOpen: false },
          };
        });
      },
      dismissTutorial() {
        setUi({ tutorialSeen: true });
      },
      leaveShop() {
        // しおりができたあとなら、外は縁日の通り。ガイドが付き添う
        if (shioriReady(get())) {
          arriveOnStreet();
          return;
        }
        setUi({
          view: "storefront",
          dialogueOpen: false,
          drawerOpen: false,
          candidatesOpen: false,
        });
      },
      leaveWithGuide(animate = false) {
        if (get().itinerary.current === null || get().ui.leadingOut) return;
        if (!animate) {
          arriveOnStreet();
          return;
        }
        setUi({
          view: "shop",
          leadingOut: true,
          dialogueOpen: false,
          drawerOpen: false,
          candidatesOpen: false,
        });
        later(LEAD_OUT_MS, () => {
          // 先導の間にしおりを開くか、自分で外へ出ていたら、もう移らない
          const { view, leadingOut } = get().ui;
          if (leadingOut && view === "shop") arriveOnStreet();
          else if (leadingOut) setUi({ leadingOut: false });
        });
      },
      async returnToShop() {
        stopGuide();
        // 開いた相談がなければ（ガイドのない環境で残した旅を開いたとき）、新しい相談から始める
        if (get().session.id === null) {
          await actions.restart();
          return;
        }
        update((state) => ({
          ...state,
          guide: {
            ...state.guide,
            streaming: false,
            entries: closeText(state.guide.entries),
            openStall: null,
            listOpen: false,
            dialogueOpen: false,
            lead: null,
          },
          ui: { ...state.ui, view: "shop", dialogueOpen: false },
        }));
      },
      async loadGuide(force = false) {
        const { session, guide } = get();
        if (!force && (guide.availability === "ready" || guide.availability === "loading")) return;
        if (session.id === null || transport.guideState === undefined) {
          updateGuide((state) => ({ ...state, availability: "unavailable" }));
          return;
        }
        // 話せている間は、読み直しの間も話せるままにする
        if (guide.availability !== "ready") {
          updateGuide((state) => ({ ...state, availability: "loading" }));
        }
        guideStateController?.abort();
        const current = new AbortController();
        guideStateController = current;
        /** 遅れた応答を、別の相談に入れない */
        const stale = () => current.signal.aborted || get().session.id !== session.id;
        try {
          const response = await transport.guideState(session.id, current.signal);
          if (!stale()) updateGuide((state) => applyGuideState(state, response));
        } catch (caught) {
          if (stale()) return;
          const status = caught instanceof TransportError ? caught.status : undefined;
          if (status === 401 || status === 403) {
            update((state) => requirePasscode(state, transport.hasPasscode?.() ?? false));
          }
          updateGuide((state) => ({
            ...state,
            // 404 と 409 は待っても話せない。屋台の情報だけを読めるようにする
            availability: status === 404 || status === 409 ? "unavailable" : "failed",
          }));
        }
      },
      async sendGuide(text) {
        const message = text.trim();
        if (message.length === 0 || message.length > MAX_MESSAGE_LENGTH) return;
        await runGuideTurn(message, false);
      },
      async retryGuide() {
        const { lastMessage } = get().guide;
        if (lastMessage !== null) await runGuideTurn(lastMessage, true);
      },
      openStall(stall) {
        const { guide, session } = get();
        const ids = noticesOfStall(guide, stall)
          .filter((notice) => notice.readAt === null)
          .map((notice) => notice.id);
        updateGuide((state) => ({
          ...markRead(state, ids, new Date().toISOString()),
          openStall: stall,
          listOpen: false,
          dialogueOpen: false,
          lead: state.lead === null ? null : { ...state.lead, done: true },
        }));
        if (ids.length > 0 && session.id !== null) {
          // 届かなくても、この画面では読んだままにする（次に開いたときに、また知らせるだけ）
          void transport
            .markNoticesRead?.({ sessionId: session.id, noticeIds: ids })
            .then((response) => {
              // 上限で押し出された通知があると、手元の未読の数が合わない。サーバーの数に合わせる
              const parsed = MarkNoticesReadResponseSchema.safeParse(response);
              if (parsed.success && unreadDiffers(get().guide, parsed.data.unread)) {
                void get().actions.loadGuide(true);
              }
            })
            .catch(() => undefined);
        }
      },
      closeStall() {
        // 屋台を閉じたら、待っていた次の報告へ進む
        // 決める操作の結果は、その屋台を見ている間だけ出す
        updateGuide((state) =>
          advanceReport({
            ...state,
            openStall: null,
            outcome: state.busy === null ? null : state.outcome,
          }),
        );
      },
      setStallList(open) {
        updateGuide((state) => ({
          ...state,
          listOpen: open,
          ...(open ? { openStall: null } : {}),
        }));
      },
      setGuideDialogue(open) {
        updateGuide((state) =>
          open
            ? advanceReport({
                ...state,
                dialogueOpen: true,
                spot: "player",
                openStall: null,
                listOpen: false,
              })
            : { ...state, dialogueOpen: false },
        );
      },
      leadToStall(stall) {
        updateGuide((state) => ({
          ...state,
          report: null,
          spot: stall,
          dialogueOpen: false,
          listOpen: false,
          lead: { stall, seq: (state.lead?.seq ?? 0) + 1, done: false },
        }));
        if (!get().guide.sceneReady) actions.openStall(stall);
      },
      setStreetScene(ready) {
        updateGuide((state) => ({ ...state, sceneReady: ready }));
        const { lead } = get().guide;
        if (!ready && lead !== null && !lead.done) actions.openStall(lead.stall);
      },
      dismissReport() {
        updateGuide((state) => advanceReport({ ...state, report: null }));
      },
      async setGuideWatch(action) {
        const setTripWatch = transport.setTripWatch;
        if (setTripWatch === undefined) return;
        await runGuideAction({ kind: "watch" }, async (sessionId) => {
          const watch = await setTripWatch({ sessionId, action });
          updateGuide((state) => applyWatch(state, watch));
        });
      },
      async decideProposal(proposalId, decision) {
        const decide = transport.decideProposal;
        const proposal = get().guide.proposals.find((item) => item.id === proposalId);
        if (decide === undefined || proposal === undefined) return;
        await runGuideAction({ kind: "proposal", id: proposalId }, async (sessionId) => {
          const response = await decide(
            proposalId,
            decision === "approve"
              ? {
                  decision,
                  sessionId,
                  baseVersion: proposal.baseVersion,
                  contentHash: proposal.contentHash,
                }
              : { decision, sessionId },
          );
          if (response.outcome === "applied") applyTripChange(response.change);
          updateGuide((state) => applyDecision(state, proposalId, response));
          // 承認で新しい版になったときと、当てられなかったときは、提案と版を読み直す
          if (response.outcome !== "rejected") void get().actions.loadGuide(true);
        });
      },
      async revertGuideChange() {
        const revertTrip = transport.revertTrip;
        const toVersion = get().guide.revertTo;
        if (revertTrip === undefined || toVersion === null) return;
        await runGuideAction({ kind: "revert" }, async (sessionId) => {
          const change = await revertTrip({ sessionId, toVersion });
          applyTripChange(change);
          updateGuide((state) => applyRevert(state, change));
          void get().actions.loadGuide(true);
        });
      },
      async openSavedTrip(tripId) {
        if (transport.openSavedTrip === undefined) return false;
        let opened: Awaited<ReturnType<NonNullable<ChatTransport["openSavedTrip"]>>>;
        try {
          opened = await transport.openSavedTrip(tripId);
        } catch {
          return false;
        }
        // 前の相談の通信を止め、前の人の会話や確認の結果を残さない
        controller?.abort();
        controller = null;
        sessionController?.abort();
        searchController?.abort();
        previewController?.abort();
        stopGuide();
        clearTimers();
        const { sessionId, itinerary } = opened;
        update((state) => {
          const { ui, festivals: known, festivalLoad, auth } = state;
          const fresh = initialData({ locale: ui.locale, tutorialSeen: ui.tutorialSeen });
          return {
            ...fresh,
            quiz: { ...fresh.quiz, deck: shuffleDeck(fresh.quiz.deck, random) },
            session: {
              ...fresh.session,
              id: sessionId,
              mode: transport.agentMode?.() ?? null,
              status: sessionId === null ? "closed" : "ready",
              stage: "shiori",
            },
            preferences: itinerary.preferences,
            itinerary: { current: itinerary, previous: null, diff: null },
            verify: verifyFromItinerary(itinerary),
            festivals: known,
            festivalLoad,
            auth,
            ui: { ...fresh.ui, soundOn: ui.soundOn },
          };
        });
        arriveOnStreet();
        return true;
      },
      nextTrivia() {
        update((state) => ({ ...state, trivia: { index: state.trivia.index + 1 } }));
      },
      prevTrivia() {
        update((state) => ({ ...state, trivia: { index: state.trivia.index - 1 } }));
      },
      answerQuiz(quizId, choice) {
        const quiz = quizById(quizId);
        if (quiz !== undefined) update((state) => answerQuiz(state, quiz, choice));
      },

      async ensureFestivals(ids) {
        const pending = [...new Set(ids)].filter((id) => get().festivalLoad[id] === undefined);
        if (pending.length === 0) {
          return;
        }
        update((state) => ({
          ...state,
          festivalLoad: {
            ...state.festivalLoad,
            ...Object.fromEntries(pending.map((id) => [id, "loading" as const])),
          },
        }));
        await Promise.all(
          pending.map(async (id) => {
            const festival = await festivals.load(id).catch(() => null);
            update((state) => ({
              ...state,
              festivals:
                festival === null ? state.festivals : { ...state.festivals, [id]: festival },
              festivalLoad: {
                ...state.festivalLoad,
                [id]: festival === null ? "missing" : "loaded",
              },
            }));
          }),
        );
      },
    };

    const initial = initialData({
      locale: deps.locale ?? "ja",
      tutorialSeen: deps.tutorialSeen ?? false,
    });
    return {
      ...initial,
      quiz: { ...initial.quiz, deck: shuffleDeck(initial.quiz.deck, random) },
      actions,
    };
  });
}
