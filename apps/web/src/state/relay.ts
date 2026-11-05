import type { RedoSubject, StaffId } from "@matsuri-ikoka/schema";
import type {
  AppData,
  RelayEntry,
  RelayState,
  StaffActivity,
  StaffState,
  StaffTask,
} from "./types";

// スタッフどうしの頼みと受け渡し。SSE のイベントから events.ts がここを呼び、ストアの relay を作る。
// サーバーは「だれが作業を始めたか・ツールを使い終えたか」だけを送るので、
// 頼みと受け渡しはその並びから決まった決まりで組み立てる（モデルの文章は使わない）。
// - 頼み：スタッフが作業を始めたら、コンシェルジュがその人に頼んだことにする
// - 受け渡し：ツールを使い終えたスタッフは結果を持つ。次に旅程係が動き出したら旅程係へ、
//   コンシェルジュが話し始めたら・返答が終わったらコンシェルジュへ渡す

/** 記録に残す頼みと受け渡しの数の上限（古いものから捨てる） */
export const RELAY_LOG_LIMIT = 40;

function append(
  relay: RelayState,
  entry: Omit<RelayEntry, "id">,
): { relay: RelayState; entry: RelayEntry } {
  const last = relay.log.at(-1);
  const full: RelayEntry = { ...entry, id: (last?.id ?? 0) + 1 };
  return { relay: { ...relay, log: [...relay.log, full].slice(-RELAY_LOG_LIMIT) }, entry: full };
}

/** 結果を持っているスタッフに、渡すものを作った作業を引く */
function taskOf(state: AppData, id: StaffId): StaffTask | null {
  const task = state.staff[id].task;
  if (task !== null) return task;
  // 戻り始めたスタッフは作業を手放しているので、この発言の頼みから引く
  const asked = state.relay.log.findLast(
    (entry) => entry.kind === "request" && entry.to === id && entry.turn === state.session.turn,
  );
  return asked?.task ?? null;
}

/** 結果を持っているスタッフ（except を除く）から、to へ結果を渡す */
export function handOver(state: AppData, to: StaffId, except: StaffId | null = null): AppData {
  let relay = state.relay;
  const keep: StaffId[] = [];
  let receivedFrom: StaffId | null = null;
  for (const from of state.relay.holding) {
    const task = taskOf(state, from);
    if (from === except || from === to || task === null) {
      if (from === except) keep.push(from);
      continue;
    }
    relay = append(relay, { turn: state.session.turn, kind: "handoff", from, to, task }).relay;
    receivedFrom = from;
  }
  if (relay === state.relay && keep.length === state.relay.holding.length) return state;
  return {
    ...state,
    relay: {
      ...relay,
      holding: keep,
      focus: to === "concierge" && receivedFrom !== null ? receivedFrom : relay.focus,
    },
  };
}

/** コンシェルジュがスタッフに作業を頼む（staff.start） */
export function requestWork(state: AppData, to: StaffId, task: StaffTask): AppData {
  if (to === "concierge") return state;
  // 旅程係が動き出すときは、ほかのスタッフの結果を旅程係へ。それ以外はコンシェルジュへ
  let next = handOver(state, to === "planner" ? "planner" : "concierge", to);
  const { relay } = append(next.relay, {
    turn: next.session.turn,
    kind: "request",
    from: "concierge",
    to,
    task,
  });
  next = { ...next, relay: { ...relay, asking: { to, task }, focus: to } };
  return next;
}

/** 調べ直しで足りないものから、それを調べる作業を引く */
const REDO_TASK: Record<RedoSubject, StaffTask> = {
  lunch: "find_nearby",
  dinner: "find_nearby",
  sightseeing: "find_nearby",
  route: "plan_route",
  last_mile: "plan_route",
  lodging: "plan_route",
};

/**
 * 調べ直しの頼み（redo_request：from が to に頼む）と受け（redo_accept：from が to の頼みを受ける）。
 * サーバーの staff.redo をそのまま記録に残す
 */
export function requestRedo(
  state: AppData,
  kind: "request" | "accept",
  from: StaffId,
  to: StaffId,
  subject: RedoSubject,
): AppData {
  const { relay } = append(state.relay, {
    turn: state.session.turn,
    kind: kind === "request" ? "redo_request" : "redo_accept",
    from,
    to,
    task: REDO_TASK[subject],
    subject,
  });
  return { ...state, relay: { ...relay, focus: kind === "request" ? to : relay.focus } };
}

/** スタッフがツールを使い終えた（tool.end）。うまくいけば結果を持つ。頼みの吹き出しはここで下ろす */
export function finishTool(state: AppData, staff: StaffId, ok: boolean): AppData {
  if (staff === "concierge") return state;
  const asking = state.relay.asking?.to === staff ? null : state.relay.asking;
  const holding =
    ok && !state.relay.holding.includes(staff)
      ? [...state.relay.holding, staff]
      : state.relay.holding;
  if (asking === state.relay.asking && holding === state.relay.holding) return state;
  return { ...state, relay: { ...state.relay, asking, holding } };
}

/** コンシェルジュが話し始めた。持っている結果はコンシェルジュが受け取ってから話す */
export function conciergeSpeaks(state: AppData): AppData {
  const next = handOver(state, "concierge");
  return next.relay.asking === null ? next : { ...next, relay: { ...next.relay, asking: null } };
}

/** 返答が終わった。残っている結果をコンシェルジュに渡し、頼みと向きを片付ける */
export function closeRelay(state: AppData): AppData {
  const next = handOver(state, "concierge");
  return { ...next, relay: { ...next.relay, asking: null, focus: null, holding: [] } };
}

// ---------------------------------------------------------------------------
// 画面で読む形

/** この発言の頼みと受け渡し（新しいものが後ろ） */
export function turnRelays(state: Pick<AppData, "relay" | "session">): RelayEntry[] {
  return state.relay.log.filter((entry) => entry.turn === state.session.turn);
}

/**
 * 頭の上に出す、いまのようす（調べている・確かめている・まとめている など）。
 * 待機中・戻る途中・話しているだけのときは null
 */
export function staffActivity(
  id: StaffId,
  staff: StaffState,
  relay: Pick<RelayState, "asking">,
): StaffActivity | null {
  if (staff.motion === "carry") return "delivering";
  switch (staff.tool) {
    case "search_festivals":
    case "search_nearby":
    case "research_route":
    case "search_lodging":
      return "researching";
    case "get_access":
    case "get_weather":
    case "verify_festival":
      return "checking";
    case "update_itinerary":
      return "summarizing";
    case null:
      break;
  }
  if (id === "concierge") return relay.asking === null ? null : "asking";
  if (staff.phase === "walking") return "heading";
  if (staff.phase === "working") return "summarizing";
  return null;
}
