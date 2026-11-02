import type { Itinerary, SseEvent, SseEventOf, StaffId, ToolName } from "@matsuri-ikoka/schema";
import type {
  AppData,
  ChatEntry,
  QuestId,
  QuestState,
  StaffMotion,
  StaffState,
  VerifyState,
} from "./types";

// SSE のイベントを、ストアの更新に変える。ここだけがイベントを読み、部品はストアだけを読む。
// どれも純粋な関数にして、同じ状態と同じイベントからは、いつも同じ状態を返す。

/** ツールを使っている間のスタッフの動き（エージェントの仕様の「フックと画面の動き」） */
const TOOL_MOTION: Record<ToolName, StaffMotion> = {
  search_festivals: "flip",
  search_nearby: "point",
  get_access: "look_up",
  get_weather: "look_up",
  update_itinerary: "flip",
  verify_festival: "flip",
};

/** ツールが進めるクエスト。再確認はクエストに入らない */
export const TOOL_QUEST: Partial<Record<ToolName, QuestId>> = {
  search_festivals: "festivals",
  search_nearby: "nearby",
  get_access: "route",
  get_weather: "route",
  update_itinerary: "route",
};

/** 終わるとクエストが完了になるツール */
const QUEST_FINISHER: Record<QuestId, ToolName> = {
  festivals: "search_festivals",
  nearby: "search_nearby",
  route: "update_itinerary",
};

export function applyEvent(state: AppData, event: SseEvent): AppData {
  switch (event.type) {
    case "staff.start":
      return onStaffStart(state, event.data);
    case "tool.start":
      return onToolStart(state, event.data);
    case "tool.end":
      return onToolEnd(state, event.data);
    case "itinerary.updated":
      return onItineraryUpdated(state, event.data);
    case "festival.verified":
      return onFestivalVerified(state, event.data);
    case "message.delta":
      return onMessageDelta(state, event.data);
    case "error":
      return onError(state, event.data);
    case "done":
      return onDone(state, event.data);
  }
}

// ---------------------------------------------------------------------------

export function patchStaff(state: AppData, id: StaffId, patch: Partial<StaffState>): AppData {
  const previous = state.staff[id];
  return {
    ...state,
    staff: { ...state.staff, [id]: { ...previous, ...patch, seq: previous.seq + 1 } },
  };
}

function addUnique<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? [...list] : [...list, value];
}

function updateEntry(
  messages: readonly ChatEntry[],
  id: string,
  update: (entry: ChatEntry) => ChatEntry,
): ChatEntry[] {
  return messages.map((entry) => (entry.id === id ? update(entry) : entry));
}

/** 仕事を終えて持ち場に立っているスタッフ（作業中でツールを使っていない） */
function isFinishedAtPost(staff: StaffState): boolean {
  return (staff.phase === "working" || staff.phase === "walking") && staff.tool === null;
}

function onStaffStart(state: AppData, data: SseEventOf<"staff.start">["data"]): AppData {
  // 別のスタッフが動き出したら、仕事を終えたスタッフは戻る
  let next = state;
  for (const id of Object.keys(state.staff) as StaffId[]) {
    const staff = state.staff[id];
    if (id !== data.staff && id !== "concierge" && isFinishedAtPost(staff)) {
      next = patchStaff(next, id, { phase: "returning", motion: "walk", task: null });
    }
  }
  next = patchStaff(next, data.staff, {
    phase: "walking",
    motion: "walk",
    task: data.task,
    tool: null,
    bubble: data.bubble,
  });
  return {
    ...next,
    session: { ...next.session, turnTasks: addUnique(next.session.turnTasks, data.task) },
  };
}

function onToolStart(state: AppData, data: SseEventOf<"tool.start">["data"]): AppData {
  let next = patchStaff(state, data.staff, {
    phase: "working",
    motion: TOOL_MOTION[data.tool],
    tool: data.tool,
    bubble: data.bubble,
  });
  const entry: ChatEntry = {
    kind: "work",
    id: `w-${data.toolCallId}`,
    staff: data.staff,
    tool: data.tool,
    status: "running",
    bubble: data.bubble,
    result: null,
  };
  next = {
    ...next,
    messages: [...next.messages, entry],
    session: { ...next.session, turnTools: addUnique(next.session.turnTools, data.tool) },
  };

  const questId = TOOL_QUEST[data.tool];
  if (questId !== undefined) {
    const quest = next.quests[questId];
    next = { ...next, quests: { ...next.quests, [questId]: { ...quest, status: "active" } } };
  }
  if (data.tool === "verify_festival") {
    next = { ...next, verify: { ...next.verify, status: "checking", result: null } };
  }
  return next;
}

function onToolEnd(state: AppData, data: SseEventOf<"tool.end">["data"]): AppData {
  let next = patchStaff(state, data.staff, {
    phase: "working",
    motion: "nod",
    tool: null,
    bubble: data.bubble,
  });

  const id = `w-${data.toolCallId}`;
  const status = data.ok ? "ok" : "failed";
  const hasEntry = next.messages.some((entry) => entry.id === id);
  next = {
    ...next,
    messages: hasEntry
      ? updateEntry(next.messages, id, (entry) =>
          entry.kind === "work" ? { ...entry, status, result: data.bubble } : entry,
        )
      : [
          ...next.messages,
          {
            kind: "work",
            id,
            staff: data.staff,
            tool: data.tool,
            status,
            bubble: data.bubble,
            result: data.bubble,
          },
        ],
  };

  if (data.ok && data.candidates !== undefined) {
    next = {
      ...next,
      candidates: data.candidates,
      ui: { ...next.ui, candidatesOpen: data.candidates.length > 0 },
    };
  }
  if (data.ok && data.spots !== undefined) {
    next = { ...next, spots: data.spots };
  }

  const questId = TOOL_QUEST[data.tool];
  if (questId !== undefined) {
    const quest = next.quests[questId];
    const updated = data.ok
      ? data.tool === QUEST_FINISHER[questId]
        ? {
            status: "done" as const,
            finished: addUnique(quest.finished, data.tool),
            completions: quest.completions + 1,
          }
        : { ...quest, finished: addUnique(quest.finished, data.tool) }
      : { ...quest, status: quest.completions > 0 ? ("done" as const) : ("todo" as const) };
    next = { ...next, quests: { ...next.quests, [questId]: updated } };
  }
  if (data.tool === "verify_festival" && !data.ok) {
    next = { ...next, verify: { ...next.verify, status: "idle" } };
  }
  return next;
}

function onItineraryUpdated(
  state: AppData,
  data: SseEventOf<"itinerary.updated">["data"],
): AppData {
  const first = state.itinerary.current === null;
  let next = patchStaff(state, "planner", { motion: "carry" });
  const route = next.quests.route;
  next = {
    ...next,
    itinerary: { current: data.itinerary, previous: state.itinerary.current, diff: data.diff },
    // 再確認の結果は、旅程が持っているものを正とする（同じ祭り・同じ日なら引き継がれる）
    verify: verifyFromItinerary(data.itinerary),
    quests:
      route.status === "done"
        ? next.quests
        : {
            ...next.quests,
            route: { ...route, status: "done", completions: route.completions + 1 },
          },
    ui: { ...next.ui, candidatesOpen: false, tab: first ? "itinerary" : next.ui.tab },
  };
  return next;
}

/** 旅程が持っている再確認の結果から、再確認の状態を作る */
export function verifyFromItinerary(itinerary: Itinerary): VerifyState {
  const { verification } = itinerary;
  if (verification.status === "pending") {
    return {
      status: "idle",
      festivalId: null,
      result: null,
      checkedAt: null,
      sources: [],
      note: null,
    };
  }
  return {
    status: "done",
    festivalId: itinerary.mainFestivalId,
    result: verification.status,
    checkedAt: verification.checkedAt,
    sources: verification.sources,
    note: verification.note ?? null,
  };
}

function onFestivalVerified(
  state: AppData,
  data: SseEventOf<"festival.verified">["data"],
): AppData {
  const next = patchStaff(state, "concierge", { phase: "working", motion: "stamp" });
  return {
    ...next,
    verify: {
      status: "done",
      festivalId: data.festivalId,
      result: data.result,
      checkedAt: data.checkedAt,
      sources: data.sources,
      note: data.note ?? null,
    },
  };
}

function onMessageDelta(state: AppData, data: SseEventOf<"message.delta">["data"]): AppData {
  const id = `c-${data.messageId}`;
  const exists = state.messages.some((entry) => entry.id === id);
  const messages: ChatEntry[] = exists
    ? updateEntry(state.messages, id, (entry) =>
        entry.kind === "concierge" ? { ...entry, text: entry.text + data.text } : entry,
      )
    : [...state.messages, { kind: "concierge", id, text: data.text, streaming: true }];
  const next =
    state.staff.concierge.motion === "talk"
      ? state
      : patchStaff(state, "concierge", {
          motion: "talk",
        });
  return { ...next, messages };
}

function onError(state: AppData, data: SseEventOf<"error">["data"]): AppData {
  const entry: ChatEntry = {
    kind: "error",
    id: `e-${state.session.turn}-${state.messages.length}`,
    code: data.code,
    message: data.message,
    retryable: data.retryable,
    resolved: false,
  };
  return { ...state, messages: [...state.messages, entry] };
}

/**
 * 返答が終わったときの片付け。done が来たときも、来ないまま接続が閉じたときも通る。
 * 時間切れのときは、終わっていないツールの tool.end が来ないので、ここで片付ける：
 * スタッフを戻す、流れている文章を閉じる、作業中の記録を失敗にする、
 * 確かめている途中の再確認を戻す、進行中のクエストを戻す、クイズを閉じる。
 */
export function closeTurn(state: AppData): AppData {
  let next: AppData = {
    ...state,
    messages: state.messages.map((entry) => {
      if (entry.kind === "concierge" && entry.streaming) {
        return { ...entry, streaming: false };
      }
      if (entry.kind === "work" && entry.status === "running") {
        return { ...entry, status: "failed" };
      }
      return entry;
    }),
    verify: state.verify.status === "checking" ? { ...state.verify, status: "idle" } : state.verify,
    quests: Object.fromEntries(
      (Object.entries(state.quests) as [QuestId, QuestState][]).map(([id, quest]) => [
        id,
        quest.status === "active"
          ? { ...quest, status: quest.completions > 0 ? "done" : "todo" }
          : quest,
      ]),
    ) as Record<QuestId, QuestState>,
    quiz: { ...state.quiz, question: null, answer: null },
  };
  for (const id of Object.keys(state.staff) as StaffId[]) {
    const staff = state.staff[id];
    if (id === "concierge") {
      if (staff.phase !== "idle" || staff.motion !== "idle") {
        next = patchStaff(next, id, {
          phase: "idle",
          motion: "idle",
          task: null,
          tool: null,
          bubble: null,
        });
      }
    } else if (staff.phase !== "idle" && staff.phase !== "returning") {
      next = patchStaff(next, id, { phase: "returning", motion: "walk", task: null, tool: null });
    }
  }
  return next;
}

function onDone(state: AppData, data: SseEventOf<"done">["data"]): AppData {
  const next = closeTurn(state);
  const reachedShiori =
    data.stage === "shiori" &&
    state.session.stage !== "shiori" &&
    state.verify.result === "as_planned";
  return {
    ...next,
    session: {
      ...next.session,
      stage: data.stage,
      conditions: data.conditions,
      sawDone: true,
    },
    preferences: data.preferences,
    ui: {
      ...next.ui,
      // 候補を開くのは候補が届いたときだけ。利用者が閉じた候補を、ここで開き直さない
      candidatesOpen: data.stage === "candidates" && next.ui.candidatesOpen,
      celebrating: next.ui.celebrating || reachedShiori,
    },
  };
}
