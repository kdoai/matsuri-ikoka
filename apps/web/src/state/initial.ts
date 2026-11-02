import { DEFAULT_PREFERENCES, STAFF_IDS, type StaffId } from "@matsuri-ikoka/schema";
import {
  type AppData,
  type Locale,
  QUEST_IDS,
  type QuestId,
  type QuestState,
  type StaffState,
  type TransportKind,
} from "./types";

export const IDLE_STAFF: StaffState = Object.freeze({
  phase: "idle",
  motion: "idle",
  task: null,
  tool: null,
  bubble: null,
  seq: 0,
});

const TODO_QUEST: QuestState = Object.freeze({ status: "todo", finished: [], completions: 0 });

function byStaff<T>(value: T): Record<StaffId, T> {
  return Object.fromEntries(STAFF_IDS.map((id) => [id, value])) as Record<StaffId, T>;
}

function byQuest<T>(value: T): Record<QuestId, T> {
  return Object.fromEntries(QUEST_IDS.map((id) => [id, value])) as Record<QuestId, T>;
}

export interface InitialOptions {
  transport: TransportKind;
  locale?: Locale;
}

/** 相談を始める前の状態。新しい相談を始めるときも、ここから作り直す */
export function initialData({ transport, locale = "ja" }: InitialOptions): AppData {
  return {
    transport,
    session: {
      id: null,
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
    },
    preferences: { ...DEFAULT_PREFERENCES },
    messages: [],
    staff: byStaff(IDLE_STAFF),
    candidates: [],
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
    quests: byQuest(TODO_QUEST),
    quiz: { offeredTurn: null, question: null, answer: null },
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
    },
  };
}
