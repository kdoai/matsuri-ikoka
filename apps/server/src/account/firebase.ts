import type { AuthConfig } from "@matsuri-ikoka/schema";
import { MemoryTripStorage } from "../storage/memory";
import type { TripStorage } from "../storage/types";
import type { IdTokenVerifier } from "./idToken";

// Firebase（ログインと Firestore）の設定。値は環境変数から読む（docs/spec/account.md）。
// 鍵のファイルは使わない。Cloud Run では実行用のサービスアカウントの権限で、手元ではエミュレーターで動かす
// （Admin SDK は FIRESTORE_EMULATOR_HOST と FIREBASE_AUTH_EMULATOR_HOST があれば、エミュレーターにつなぐ）。
// Admin SDK は読み込みに時間がかかるので、Firestore かログインを使うときだけ読み込む（起動を遅くしない）。

export interface AccountConfig {
  /** 保存先。memory はインスタンスのメモリ（再起動で消える） */
  storage: "memory" | "firestore";
  /** Firebase（Google Cloud）のプロジェクト ID。ログインと Firestore に使う */
  projectId: string | null;
  /** Firestore のデータベースの ID（省略時は (default)） */
  databaseId: string | null;
  /** 画面に渡すログインの公開の設定。ログインを用意していなければ enabled: false */
  web: AuthConfig;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function readAccountConfig(env: NodeJS.ProcessEnv): AccountConfig {
  const storage = nonEmpty(env.MATSURI_STORAGE) ?? "memory";
  if (storage !== "memory" && storage !== "firestore") {
    throw new Error("MATSURI_STORAGE は memory か firestore にしてください");
  }
  const projectId = nonEmpty(env.FIREBASE_PROJECT_ID);
  if (storage === "firestore" && projectId === null) {
    throw new Error("MATSURI_STORAGE=firestore には FIREBASE_PROJECT_ID が要ります");
  }
  const apiKey = nonEmpty(env.FIREBASE_WEB_API_KEY);
  const authDomain = nonEmpty(env.FIREBASE_AUTH_DOMAIN);
  const authEmulator = nonEmpty(env.FIREBASE_AUTH_EMULATOR_HOST);
  const web: AuthConfig =
    projectId !== null && apiKey !== null && authDomain !== null
      ? {
          enabled: true,
          apiKey,
          authDomain,
          projectId,
          ...(authEmulator === null ? {} : { emulatorUrl: `http://${authEmulator}` }),
        }
      : { enabled: false };
  return { storage, projectId, databaseId: nonEmpty(env.FIRESTORE_DATABASE_ID), web };
}

export interface Account {
  storage: TripStorage;
  /** ログインを用意していなければ null（旅の保存の API は 404 で断る） */
  verifier: IdTokenVerifier | null;
  web: AuthConfig;
}

export async function createAccount(config: AccountConfig): Promise<Account> {
  if (config.storage === "memory" && !config.web.enabled) {
    return { storage: new MemoryTripStorage(), verifier: null, web: config.web };
  }
  const [{ initializeApp }, { getAuth }, { getFirestore }, { FirestoreTripStorage }] =
    await Promise.all([
      import("firebase-admin/app"),
      import("firebase-admin/auth"),
      import("firebase-admin/firestore"),
      import("../storage/firestore"),
    ]);
  const app = initializeApp(config.projectId === null ? {} : { projectId: config.projectId });
  const storage =
    config.storage === "firestore"
      ? new FirestoreTripStorage(
          config.databaseId === null ? getFirestore(app) : getFirestore(app, config.databaseId),
        )
      : new MemoryTripStorage();
  const auth = getAuth(app);
  const verifier: IdTokenVerifier | null = config.web.enabled
    ? {
        async verify(token) {
          try {
            return (await auth.verifyIdToken(token)).uid;
          } catch {
            return null;
          }
        },
      }
    : null;
  return { storage, verifier, web: config.web };
}
