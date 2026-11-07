import type { Firestore } from "firebase-admin/firestore";
import { readAccountConfig } from "../account/firebase";
import type { FestivalStore } from "../data/festivalStore";
import type { LodgingService } from "../tools/lodging";
import { createManagedPatrolAgent } from "./agent";
import { readPatrolConfig } from "./config";
import { createPageFetcher } from "./pageFetcher";
import type { PatrolDeps } from "./runner";
import { MemoryPatrolStore } from "./store";

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

/**
 * 見回りの部品を作る。設定がなければ null で、見回りの入口だけが断る。
 * SDK は読み込みに時間がかかるので、見回りを動かす環境でだけ読み込む
 */
export async function createPatrolDeps(input: {
  env: NodeJS.ProcessEnv;
  festivals: FestivalStore;
  lodging: LodgingService;
  now?: () => number;
}): Promise<PatrolDeps | null> {
  const config = readPatrolConfig(input.env);
  if (config === null) return null;
  const db = await patrolDatabase(input.env);
  const [{ default: Anthropic }, store] = await Promise.all([
    import("@anthropic-ai/sdk"),
    db === null
      ? Promise.resolve(new MemoryPatrolStore())
      : import("./firestoreStore").then(({ FirestorePatrolStore }) => new FirestorePatrolStore(db)),
  ]);
  return {
    store,
    agent: createManagedPatrolAgent(new Anthropic({ apiKey: config.apiKey, timeout: 30_000 })),
    pages: createPageFetcher(),
    festivals: input.festivals,
    lodging: input.lodging,
    config,
    now: input.now ?? Date.now,
  };
}
