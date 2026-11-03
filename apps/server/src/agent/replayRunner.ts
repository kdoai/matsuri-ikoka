import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type SampleConversation,
  SampleConversationSchema,
  type SseEvent,
} from "@matsuri-ikoka/schema";
import { type ItineraryStore, randomId, type Session } from "../session/sessionStore";
import type { AgentRunner, EmitEvent, TurnInput } from "./runner";

// mock：記録したサンプルの相談（data/samples/conversations/*.json）を、記録した間隔で再生する。
// 発言の中身は見ずに、相談ごとに次の発言の記録を流す。旅程やしおりも引けるよう、相談の状態にも反映する。

const END_OF_SAMPLE =
  "このサンプルの相談はここまでです。もう一度試すときは、新しい相談を始めてください。";

export async function loadSampleConversations(dir: string): Promise<SampleConversation[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (name) =>
      SampleConversationSchema.parse(JSON.parse(await readFile(path.join(dir, name), "utf8"))),
    ),
  );
}

/** ms だけ待つ。止められていたら待たずに止め、待ち終えたら abort のリスナーを外す */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 記録の旅程 ID を、この相談の旅程 ID に置き換える（しおりの URL を相談ごとに分ける） */
function localizeItinerary(event: SseEvent, ids: Record<string, string>): SseEvent {
  if (event.type !== "itinerary.updated") return event;
  const recorded = event.data.itinerary.id;
  ids[recorded] ??= randomId("trip");
  const id = ids[recorded];
  return { ...event, data: { ...event.data, itinerary: { ...event.data.itinerary, id } } };
}

/** 記録したイベントを、相談の状態に反映する */
export function applyRecordedEvent(session: Session, itineraries: ItineraryStore, event: SseEvent) {
  switch (event.type) {
    case "tool.end":
      if (event.data.candidates !== undefined) session.candidates = event.data.candidates;
      break;
    case "itinerary.updated":
      itineraries.save(event.data.itinerary);
      session.itineraryId = event.data.itinerary.id;
      session.selectedFestivalId = event.data.itinerary.mainFestivalId;
      break;
    case "festival.verified": {
      const itinerary = session.itineraryId ? itineraries.get(session.itineraryId) : undefined;
      if (
        event.data.scope !== "candidate" &&
        itinerary !== undefined &&
        itinerary.mainFestivalId === event.data.festivalId
      ) {
        const { result, checkedAt, sources, note } = event.data;
        itineraries.save({
          ...itinerary,
          verification: { status: result, checkedAt, sources, ...(note ? { note } : {}) },
        });
      }
      break;
    }
    case "done":
      session.stage = event.data.stage;
      session.conditions = event.data.conditions;
      session.preferences = event.data.preferences;
      break;
    default:
      break;
  }
}

export class ReplayAgentRunner implements AgentRunner {
  readonly mode = "mock" as const;
  readonly #samples: Map<string, SampleConversation>;
  readonly #itineraries: ItineraryStore;
  /** 再生の速さの倍率。1 で記録どおり、2 で2倍速、0 で待たない（テスト用） */
  readonly #speed: number;

  constructor(
    samples: SampleConversation[],
    itineraries: ItineraryStore,
    options: { speed?: number } = {},
  ) {
    if (samples.length === 0) throw new Error("サンプルの相談がありません");
    this.#samples = new Map(samples.map((s) => [s.id, s]));
    this.#itineraries = itineraries;
    this.#speed = options.speed ?? 1;
  }

  /** 新しい相談に割り当てるサンプル。指定がなければ最初のもの */
  sampleFor(requested?: string): string | null {
    if (requested === undefined) return [...this.#samples.keys()][0] ?? null;
    return this.#samples.has(requested) ? requested : null;
  }

  async runTurn({ session, signal }: TurnInput, emit: EmitEvent): Promise<void> {
    const replay = session.replay ?? { sampleId: this.sampleFor() as string, nextTurn: 0 };
    session.replay = replay;
    const turn = this.#samples.get(replay.sampleId)?.turns[replay.nextTurn];
    if (turn === undefined) {
      // 返答ごとに別の messageId にする（画面は同じ messageId の文をつなげる）
      emit({ type: "message.delta", data: { messageId: randomId("end"), text: END_OF_SAMPLE } });
      return;
    }

    replay.itineraryIds ??= {};
    let elapsed = 0;
    for (const recorded of turn.events) {
      const wait = this.#speed === 0 ? 0 : (recorded.atMs - elapsed) / this.#speed;
      await sleep(wait, signal);
      elapsed = recorded.atMs;
      const event = localizeItinerary(recorded.event, replay.itineraryIds);
      applyRecordedEvent(session, this.#itineraries, event);
      // done は呼び出し側が相談の状態から送る
      if (event.type !== "done") emit(event);
    }
    replay.nextTurn += 1;
  }
}
