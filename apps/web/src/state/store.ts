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
import { clientError } from "./errors";
import { applyEvent } from "./events";
import { initialData } from "./initial";
import {
  addError,
  answerQuiz,
  beginTurn,
  changePreference,
  endTurn,
  offerQuiz,
  passcodeAccepted,
  requirePasscode,
  resetForNewSession,
  settleStaff,
  shouldOfferQuiz,
  type TurnStart,
} from "./transitions";
import type { AppData, ClientError, Locale, PanelTab } from "./types";
import { buildQuiz, quizFocusId } from "./waiting";

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
  /** のれんをくぐって店の外へ出る（相談はそのまま残す） */
  leaveShop(): void;
  nextTrivia(): void;
  answerQuiz(choice: 0 | 1): void;
  /** 祭りのデータを読み込む（読み込み済みのものは読まない） */
  ensureFestivals(ids: readonly string[]): Promise<void>;
}

export type AppState = AppData & { actions: AppActions };
export type AppStore = StoreApi<AppState>;

export interface StoreDeps {
  transport: ChatTransport;
  festivals: FestivalSource;
  locale?: Locale;
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createAppStore(deps: StoreDeps): AppStore {
  const { transport, festivals } = deps;
  const random = deps.random ?? Math.random;
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

    const maybeOfferQuiz = () => {
      const state = get();
      if (!shouldOfferQuiz(state)) {
        return;
      }
      const question = buildQuiz(state.festivals, quizFocusId(state), random);
      if (question !== null) {
        update((current) => offerQuiz(current, question));
      }
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
      maybeOfferQuiz();
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
      update((state) => applyEvent(state, event));
      afterEvent(event, before);
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
        update((state) =>
          passcodeAccepted({ ...state, session: { ...state.session, id, status: "ready" } }),
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
        const fresh = initialData({ locale: ui.locale });
        update(() => ({ ...fresh, ui: { ...fresh.ui, soundOn: ui.soundOn, view: "shop" } }));
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
        setUi({ dialogueOpen: open });
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
      answerQuiz(choice) {
        update((state) => answerQuiz(state, choice));
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
        maybeOfferQuiz();
      },
    };

    return {
      ...initialData({ locale: deps.locale ?? "ja" }),
      actions,
    };
  });
}
