import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type SampleConversation,
  SampleConversationSchema,
  type SseEvent,
} from "@matsuri-ikoka/schema";
import type { ItineraryStore, Session } from "../session/sessionStore";
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
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
      if (itinerary !== undefined && itinerary.mainFestivalId === event.data.festivalId) {
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
  /** 再生の速さ。1 で記録どおり、0 で待たない（テスト用） */
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
      emit({
        type: "message.delta",
        data: { messageId: `end-${session.id}`, text: END_OF_SAMPLE },
      });
      return;
    }

    let elapsed = 0;
    for (const { atMs, event } of turn.events) {
      await sleep((atMs - elapsed) * this.#speed, signal);
      elapsed = atMs;
      applyRecordedEvent(session, this.#itineraries, event);
      // done は呼び出し側が相談の状態から送る
      if (event.type !== "done") emit(event);
    }
    replay.nextTurn += 1;
  }
}
