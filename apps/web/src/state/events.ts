import type { Itinerary, SseEvent, SseEventOf, StaffId, ToolName } from "@matsuri-ikoka/schema";
import {
  closeRelay,
  conciergeSpeaks,
  finishTool,
  handOver,
  requestRedo,
  requestWork,
} from "./relay";
import type { AppData, ChatEntry, StaffMotion, StaffState, VerifyState } from "./types";

// SSE のイベントを、ストアの更新に変える。ここだけがイベントを読み、部品はストアだけを読む。
// どれも純粋な関数にして、同じ状態と同じイベントからは、いつも同じ状態を返す。

/** ツールを使っている間のスタッフの動き（エージェントの仕様の「フックと画面の動き」） */
const TOOL_MOTION: Record<ToolName, StaffMotion> = {
  search_festivals: "flip",
  search_nearby: "point",
  get_access: "look_up",
  research_route: "look_up",
  get_weather: "look_up",
  search_lodging: "point",
  update_itinerary: "flip",
  verify_festival: "flip",
};

/** 候補の窓に、見つからなかったときの案内（この祭りならやっています・次の手）を出すものがあるか */
export function hasNextSteps(search: AppData["search"]): boolean {
  return search !== null && (search.status === "none" || search.nearMisses.length > 0);
}

export function applyEvent(state: AppData, event: SseEvent): AppData {
  switch (event.type) {
    case "staff.start":
      return onStaffStart(state, event.data);
    case "tool.start":
      return onToolStart(state, event.data);
    case "tool.end":
      return onToolEnd(state, event.data);
    case "staff.redo":
      return onStaffRedo(state, event.data);
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
  // コンシェルジュが頼み、ほかのスタッフが持っている結果は旅程係かコンシェルジュへ渡る（relay.ts）
  let next = requestWork(state, data.staff, data.task);
  // 別のスタッフが動き出したら、仕事を終えたスタッフは戻る
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
    detail: null,
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
    detail: data.detail ?? null,
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

  if (data.tool === "verify_festival") {
    next = { ...next, verify: { ...next.verify, status: "checking", result: null } };
  }
  return next;
}

function onToolEnd(state: AppData, data: SseEventOf<"tool.end">["data"]): AppData {
  let next = patchStaff(finishTool(state, data.staff, data.ok), data.staff, {
    phase: "working",
    motion: "nod",
    tool: null,
    bubble: data.bubble,
    detail: data.detail ?? null,
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
    // 返答が続いている間は「この祭りにする」を押せないので、ここでは開かず、返答が終わってから開く。
    // 見つからなかったときも、「見つかりませんでした」と次の手を見せるために開く
    const search = data.search ?? null;
    next = {
      ...next,
      candidates: data.candidates,
      search,
      session: {
        ...next.session,
        newCandidates: data.candidates.length > 0 || hasNextSteps(search),
      },
    };
  }
  if (data.ok && data.spots !== undefined) {
    next = { ...next, spots: data.spots };
  }

  if (data.tool === "verify_festival" && !data.ok) {
    next = { ...next, verify: { ...next.verify, status: "idle" } };
  }
  return next;
}

/** 調べ直しの頼みと受け。頼む人・受ける人が、その場で吹き出しを出す（持ち場は動かない） */
function onStaffRedo(state: AppData, data: SseEventOf<"staff.redo">["data"]): AppData {
  const next = requestRedo(state, data.kind, data.from, data.to, data.subject);
  return patchStaff(next, data.from, {
    motion: data.kind === "request" ? "talk" : "nod",
    bubble: data.bubble,
    detail: data.detail ?? null,
  });
}

function onItineraryUpdated(
  state: AppData,
  data: SseEventOf<"itinerary.updated">["data"],
): AppData {
  const first = state.itinerary.current === null;
  // 旅程係は、できた旅程をカウンターのコンシェルジュへ運ぶ
  let next = patchStaff(handOver(state, "concierge"), "planner", { motion: "carry" });
  next = {
    ...next,
    itinerary: { current: data.itinerary, previous: state.itinerary.current, diff: data.diff },
    // 再確認の結果は、旅程が持っているものを正とする（同じ祭り・同じ日なら引き継がれる）
    verify: verifyFromItinerary(data.itinerary),
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

/** 決めた祭りが中止と分かったことを残す。祭りの結果へ戻る操作を、いちばん前に出す */
function noteAnchorCancelled(
  state: AppData,
  data: SseEventOf<"festival.verified">["data"],
): AppData {
  const { anchor } = state.consult;
  if (data.result !== "cancelled" || anchor?.festivalId !== data.festivalId) return state;
  if (data.date !== undefined && data.date !== anchor.date) return state;
  return { ...state, consult: { ...state.consult, anchorCancelled: true } };
}

function onFestivalVerified(
  state: AppData,
  data: SseEventOf<"festival.verified">["data"],
): AppData {
  const noted = noteAnchorCancelled(state, data);
  // 候補を出す前の確かめは、旅程の再確認の結果にしない
  if (data.scope === "candidate") return noted;
  const next = patchStaff(noted, "concierge", { phase: "working", motion: "stamp" });
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
  const spoken = conciergeSpeaks(state);
  const next =
    spoken.staff.concierge.motion === "talk"
      ? spoken
      : patchStaff(spoken, "concierge", {
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
 * 確かめている途中の再確認を戻す、クイズを閉じる。
 */
export function closeTurn(state: AppData): AppData {
  const relayed = closeRelay(state);
  let next: AppData = {
    ...relayed,
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
          detail: null,
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
      // 候補を開くのは、返答が終わって選べるようになったとき（endTurn）。ここでは開かない
      candidatesOpen: data.stage === "candidates" && next.ui.candidatesOpen,
      celebrating: next.ui.celebrating || reachedShiori,
    },
  };
}
