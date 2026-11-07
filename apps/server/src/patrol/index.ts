import type { Firestore } from "firebase-admin/firestore";
import type { FestivalStore } from "../data/festivalStore";
import type { LodgingService } from "../tools/lodging";
import { createManagedPatrolAgent } from "./agent";
import { readPatrolConfig } from "./config";
import { createPageFetcher } from "./pageFetcher";
import type { PatrolDeps } from "./runner";
import { MemoryPatrolStore } from "./store";

/**
 * 見回りの部品を作る。設定がなければ null で、見回りの入口だけが断る。
 * SDK は読み込みに時間がかかるので、見回りを動かす環境でだけ読み込む
 */
export async function createPatrolDeps(input: {
  env: NodeJS.ProcessEnv;
  /** Firestore を使う環境なら渡す。なければメモリに置く */
  db: Firestore | null;
  festivals: FestivalStore;
  lodging: LodgingService;
  now?: () => number;
}): Promise<PatrolDeps | null> {
  const config = readPatrolConfig(input.env);
  if (config === null) return null;
  const [{ default: Anthropic }, store] = await Promise.all([
    import("@anthropic-ai/sdk"),
    input.db === null
      ? Promise.resolve(new MemoryPatrolStore())
      : import("./firestoreStore").then(
          ({ FirestorePatrolStore }) => new FirestorePatrolStore(input.db as Firestore),
        ),
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
