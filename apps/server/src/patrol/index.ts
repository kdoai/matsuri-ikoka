import type { Firestore } from "firebase-admin/firestore";
import { readAccountConfig } from "../account/firebase";
import type { FestivalStore } from "../data/festivalStore";
import type { TripStorage } from "../storage/types";
import type { LodgingService } from "../tools/lodging";
import type { WeatherService } from "../tools/weather";
import { createManagedPatrolAgent } from "./agent";
import { readPatrolConfig } from "./config";
import { createPageFetcher } from "./pageFetcher";
import type { PatrolDeps } from "./runner";
import { MemoryPatrolStore, type PatrolTripSource } from "./store";

/**
 * 保存先が Firestore なら、旅の保存と同じデータベースを使う。なければ null。
 * アプリはログインと保存の初期化（createAccount）が作ったものを使うので、そのあとに呼ぶ
 */
async function patrolDatabase(env: NodeJS.ProcessEnv): Promise<Firestore | null> {
  const { storage, databaseId } = readAccountConfig(env);
  if (storage !== "firestore") return null;
  const [{ getApp }, { getFirestore }] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/firestore"),
  ]);
  return databaseId === null ? getFirestore(getApp()) : getFirestore(getApp(), databaseId);
}

/** メモリの見回りの口。旅の保存先もメモリなら、その置き場を使う */
function memoryPatrolStore(
  storage: (TripStorage & { patrolTrips?: () => PatrolTripSource }) | undefined,
): MemoryPatrolStore {
  const trips = storage?.kind === "memory" ? storage.patrolTrips?.() : undefined;
  return new MemoryPatrolStore(trips === undefined ? {} : { trips });
}

/**
 * 見回りの部品を作る。設定がなければ null で、見回りの入口だけが断る。
 * SDK は読み込みに時間がかかるので、見回りを動かす環境でだけ読み込む
 */
export async function createPatrolDeps(input: {
  env: NodeJS.ProcessEnv;
  festivals: FestivalStore;
  lodging: LodgingService;
  /** 声かけに添える天気の予報 */
  weather?: WeatherService;
  /** 旅の保存先。メモリなら、見回りも同じ置き場で依頼と旅程を読み、通知を書く（ガイドの API と同じ置き場） */
  storage?: TripStorage & { patrolTrips?: () => PatrolTripSource };
  now?: () => number;
}): Promise<PatrolDeps | null> {
  const config = readPatrolConfig(input.env);
  if (config === null) return null;
  const db = await patrolDatabase(input.env);
  const [{ default: Anthropic }, store] = await Promise.all([
    import("@anthropic-ai/sdk"),
    db === null
      ? Promise.resolve(memoryPatrolStore(input.storage))
      : import("./firestoreStore").then(({ FirestorePatrolStore }) => new FirestorePatrolStore(db)),
  ]);
  return {
    store,
    agent: createManagedPatrolAgent(new Anthropic({ apiKey: config.apiKey, timeout: 30_000 })),
    pages: createPageFetcher(),
    festivals: input.festivals,
    lodging: input.lodging,
    ...(input.weather === undefined ? {} : { weather: input.weather }),
    config,
    now: input.now ?? Date.now,
  };
}
