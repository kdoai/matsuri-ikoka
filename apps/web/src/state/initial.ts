import { DEFAULT_PREFERENCES, STAFF_IDS, type StaffId } from "@matsuri-ikoka/schema";
import { INITIAL_CONSULT } from "./consult";
import { INITIAL_FESTIVAL_SEARCH } from "./festivalSearch";
import { QUIZ_BANK } from "./quizBank";
import type { AppData, Locale, StaffState } from "./types";

export const IDLE_STAFF: StaffState = Object.freeze({
  phase: "idle",
  motion: "idle",
  task: null,
  tool: null,
  bubble: null,
  detail: null,
  seq: 0,
});

function byStaff<T>(value: T): Record<StaffId, T> {
  return Object.fromEntries(STAFF_IDS.map((id) => [id, value])) as Record<StaffId, T>;
}

export interface InitialOptions {
  locale?: Locale;
  /** はじめての操作の案内を、前に見終えているか */
  tutorialSeen?: boolean;
}

/** 相談を始める前の状態。新しい相談を始めるときも、ここから作り直す */
export function initialData({ locale = "ja", tutorialSeen = false }: InitialOptions = {}): AppData {
  return {
    session: {
      id: null,
      mode: null,
      status: "closed",
      stage: "hearing",
      conditions: {},
      streaming: false,
      turn: 0,
      sawDone: false,
      lastRequest: null,
      lastWasPreferences: false,
      turnTasks: [],
      turnTools: [],
      newCandidates: false,
    },
    preferences: { ...DEFAULT_PREFERENCES },
    consult: { ...INITIAL_CONSULT, answers: {} },
    festivalSearch: { ...INITIAL_FESTIVAL_SEARCH },
    messages: [],
    staff: byStaff(IDLE_STAFF),
    relay: { log: [], asking: null, focus: null, holding: [] },
    candidates: [],
    search: null,
    spots: [],
    itinerary: { current: null, previous: null, diff: null },
    verify: {
      status: "idle",
      festivalId: null,
      result: null,
      checkedAt: null,
      sources: [],
      note: null,
    },
    quiz: { deck: QUIZ_BANK.map((quiz) => quiz.id), answers: {} },
    stamps: 0,
    trivia: { index: 0 },
    festivals: {},
    festivalLoad: {},
    auth: { needed: false, rejected: false },
    ui: {
      view: "storefront",
      tab: "itinerary",
      locale,
      soundOn: false,
      candidatesOpen: false,
      drawerOpen: false,
      celebrating: false,
      draft: "",
      dialogueOpen: false,
      tutorialSeen,
    },
  };
}
