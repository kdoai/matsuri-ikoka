import {
  type Festival,
  FestivalSchema,
  type Itinerary,
  ItinerarySchema,
  type PatrolRequest,
} from "@matsuri-ikoka/schema";
import {
  FICTIONAL_FESTIVAL_ID,
  fictionalFestival,
  fictionalItinerary,
  fictionalTripWatch,
} from "@matsuri-ikoka/schema/testing";
import { createFestivalStore } from "../data/festivalStore";
import { createFictionalLodging } from "../tools/lodging";
import type { PatrolAgent, PatrolSessionState } from "./agent";
import type { PageFetcher, PageRead } from "./pageFetcher";
import type { PatrolDeps } from "./runner";
import { MemoryPatrolStore } from "./store";
import type { WatchedTrip } from "./types";

// 見回りのテストの部品。祭りは架空のもので、URL は example.com。ネットワークには出ない。

export const FESTIVAL_ID = FICTIONAL_FESTIVAL_ID;
export const PAGE_URL = "https://example.com/suzunari/2026";
export const PATROL_DATE = "2026-08-16";
/** テストの今：祭りの6日前 */
export const NOW = Date.parse("2026-08-10T06:00:00+09:00");

/** 架空の祭り。読むページを1つにする */
export function patrolFestival(): Festival {
  const festival = fictionalFestival();
  return FestivalSchema.parse({
    ...festival,
    occurrences: festival.occurrences.map((occurrence) => ({
      ...occurrence,
      sources: [{ url: PAGE_URL, checkedAt: "2026-08-01", confidence: "official" }],
    })),
    sources: [{ url: PAGE_URL, checkedAt: "2026-08-01", confidence: "official" }],
  });
}

/** 架空の祭りのページの行。十分に長いので、読めるページになる */
export function pageLinesFor(...extra: string[]): string[] {
  return [
    "鈴鳴灯籠まつりのご案内",
    "開催日 令和8年8月16日",
    "開始 18:30 / 終了 21:00",
    "小雨決行。荒天の場合は翌日に順延",
    ...extra,
  ];
}

/** 架空の旅。旅の ID や利用者の ID と、利用者の情報に印を付けて、渡るものを調べられるようにする */
export function watchedTrip(name: string): { trip: WatchedTrip; itinerary: Itinerary } {
  const itinerary = ItinerarySchema.parse({
    ...fictionalItinerary(),
    id: `trip-${name}`,
    origin: `出発地-${name}`,
  });
  return {
    trip: {
      ref: `users/user-${name}/trips/trip-${name}`,
      watch: { ...fictionalTripWatch(), tripId: `trip-${name}` },
    },
    itinerary,
  };
}

export type PagesScript = Map<string, PageRead>;

export function scriptedPages(): PageFetcher & { script: PagesScript; reads: string[] } {
  const script: PagesScript = new Map();
  const reads: string[] = [];
  return {
    script,
    reads,
    async read(url) {
      reads.push(url);
      return script.get(url) ?? { status: "failed" };
    },
  };
}

export interface ScriptedAgent extends PatrolAgent {
  requests: PatrolRequest[];
  budgets: number[];
  denied: string[][];
  /** セッションの状態を決める */
  respond: (request: PatrolRequest) => PatrolSessionState;
  failStart: boolean;
}

export function scriptedAgent(): ScriptedAgent {
  const agent: ScriptedAgent = {
    requests: [],
    budgets: [],
    denied: [],
    failStart: false,
    respond: (request) => ({
      state: "finished",
      patrolId: request.patrolId,
      text: JSON.stringify({ patrolId: request.patrolId, findings: [] }),
      fetchedUrls: [],
      costCents: 12,
    }),
    async start(request, budgetCents) {
      if (agent.failStart) throw new Error("混み合っています");
      agent.requests.push(request);
      agent.budgets.push(budgetCents);
      return `session-${agent.requests.length}`;
    },
    async read(sessionId) {
      const index = Number(sessionId.replace("session-", "")) - 1;
      const request = agent.requests[index];
      if (request === undefined) return { state: "running", patrolId: null };
      return agent.respond(request);
    },
    async deny(_sessionId, ids) {
      agent.denied.push([...ids]);
    },
  };
  return agent;
}

export interface PatrolHarness {
  deps: PatrolDeps;
  store: MemoryPatrolStore;
  pages: ReturnType<typeof scriptedPages>;
  agent: ScriptedAgent;
  clock: { now: number };
}

export function patrolHarness(over: Partial<PatrolDeps> = {}): PatrolHarness {
  const store = new MemoryPatrolStore();
  const pages = scriptedPages();
  const agent = scriptedAgent();
  const clock = { now: NOW };
  const deps: PatrolDeps = {
    store,
    agent,
    pages,
    festivals: createFestivalStore([patrolFestival()]),
    lodging: createFictionalLodging({ now: () => new Date(clock.now).toISOString() }),
    config: {
      sessionBudgetCents: 200,
      maxTargetsPerRun: 20,
      maxLodgingChecksPerRun: 10,
      checkIntervalMs: 6 * 60 * 60 * 1000,
    },
    now: () => clock.now,
    random: () => 0,
    ...over,
  };
  return { deps, store, pages, agent, clock };
}
