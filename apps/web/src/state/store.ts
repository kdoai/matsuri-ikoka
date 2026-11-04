import {
  decodeSseEvent,
  type FestivalCandidate,
  MAX_MESSAGE_LENGTH,
  type Preferences,
  type SseEvent,
  type SseMessage,
} from "@matsuri-ikoka/schema";
import { createStore, type StoreApi } from "zustand/vanilla";
import { MESSAGES } from "../i18n";
import { isSendablePasscode } from "../transport/server";
import type { ChatTransport, FestivalSource, OnSseMessage } from "../transport/types";
import { toClientError } from "../transport/types";
import {
  type ConsultAnswers,
  type ConsultQuestion,
  type ConsultStep,
  composeConsultMessage,
  pickAnswer,
  setAnswerText,
  todayInJapan,
} from "./consult";
import { clientError } from "./errors";
import { applyEvent } from "./events";
import { initialData } from "./initial";
import { quizById } from "./quizBank";
import {
  addError,
  answerQuiz,
  beginTurn,
  changePreference,
  endTurn,
  passcodeAccepted,
  requirePasscode,
  resetForNewSession,
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

export interface AppActions {
  /** 店に入り、相談を始める */
  enterShop(): Promise<void>;
  /** 発言を送る */
  send(text: string): Promise<void>;
  /** 最後の発言（またはこだわりの切り替え）を送り直す */
  retry(): Promise<void>;
  /** 候補カードから祭りを選ぶ */
  chooseCandidate(candidate: FestivalCandidate): Promise<void>;
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
  /** 選んだ内容を1つの発言にまとめて送る */
  submitConsult(): Promise<void>;
  /** 聞き取りを選び直す */
  reopenConsult(): void;
  /** はじめての操作の案内を閉じる */
  dismissTutorial(): void;
  /** のれんをくぐって店の外へ出る（相談はそのまま残す） */
  leaveShop(): void;
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

    const sendChat = async (message: string, retry: boolean) => {
      const state = get();
      const sessionId = state.session.id;
      if (state.session.streaming || sessionId === null) {
        return;
      }
      const { preferences } = state;
      if (!state.ui.dialogueOpen) setUi({ dialogueOpen: true });
      await runStream({ kind: "chat", message, preferences, retry }, (onMessage, signal) =>
        transport.chat({ sessionId, message, preferences }, onMessage, signal),
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

    const setUi = (patch: Partial<AppData["ui"]>) =>
      update((state) => ({ ...state, ui: { ...state.ui, ...patch } }));

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
          await sendChat(state.session.lastRequest.message, true);
        }
      },

      async chooseCandidate(candidate) {
        setUi({ candidatesOpen: false });
        await sendChat(MESSAGES[get().ui.locale].candidates.chooseMessage(candidate.name), false);
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
        if (get().session.status !== "ready") {
          setUi({ view: "shop" });
          await startSession();
          return;
        }
        await actions.retry();
      },

      async restart() {
        controller?.abort();
        controller = null;
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
        setUi({ candidatesOpen: open && get().candidates.length > 0 });
      },
      openShiori() {
        if (get().itinerary.current !== null) {
          setUi({ view: "shiori", drawerOpen: false });
        }
      },
      closeShiori() {
        setUi({ view: "shop" });
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
        );
        if (message === null) {
          return;
        }
        update((current) => ({ ...current, consult: { ...current.consult, active: false } }));
        await sendChat(message, false);
      },
      reopenConsult() {
        update((state) => ({
          ...state,
          consult: { ...state.consult, active: true, step: "party", editing: false },
        }));
      },
      dismissTutorial() {
        setUi({ tutorialSeen: true });
      },
      leaveShop() {
        setUi({
          view: "storefront",
          dialogueOpen: false,
          drawerOpen: false,
          candidatesOpen: false,
        });
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
