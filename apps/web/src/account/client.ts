import {
  type AuthConfig,
  AuthConfigSchema,
  ShareResponseSchema,
  TripListResponseSchema,
  type TripSummary,
  TripSummarySchema,
} from "@matsuri-ikoka/schema";
import { PASSCODE_HEADER, type PasscodeHolder } from "../transport/server";
import { errorFromResponse, TransportError } from "../transport/types";

// ログインと自分の旅（docs/spec/account.md）。
// ログインは Firebase Authentication（Google）。Firebase の部品は、ログインを用意しているときだけ読み込む。
// 旅の保存・一覧・共有・削除は接客サーバーの API に、ID トークン（Authorization: Bearer）を付けて頼む。
// ブラウザから Firestore には触らない。

export interface AccountUser {
  /** 画面に出す名前（Google のアカウントの表示名）。なければ null */
  name: string | null;
}

export interface AccountClient {
  /** ログインを用意しているか */
  enabled(): Promise<boolean>;
  /** ログインの状態が変わるたびに呼ぶ。外すための関数を返す */
  onUser(listener: (user: AccountUser | null) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  listTrips(): Promise<TripSummary[]>;
  /** 相談の旅程を、自分の旅として残す */
  saveTrip(sessionId: string): Promise<TripSummary>;
  /** しおりを30日だけ共有する URL のパス */
  shareTrip(itineraryId: string): Promise<string>;
  deleteTrip(itineraryId: string): Promise<void>;
  /** 自分の旅をすべて消し、ログインの記録（Firebase のアカウント）も消してログアウトする */
  deleteEverything(): Promise<void>;
}

/** Firebase の Auth のうち、ここで使う部分 */
interface FirebaseAuthPart {
  currentUser: { displayName: string | null; getIdToken(): Promise<string> } | null;
  onUser(listener: (user: AccountUser | null) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  deleteUser(): Promise<void>;
}

async function loadFirebase(config: Extract<AuthConfig, { enabled: true }>) {
  const [{ initializeApp }, auth] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
  ]);
  const app = initializeApp({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
  });
  const instance = auth.getAuth(app);
  if (config.emulatorUrl !== undefined) {
    auth.connectAuthEmulator(instance, config.emulatorUrl, { disableWarnings: true });
  }
  const part: FirebaseAuthPart = {
    get currentUser() {
      return instance.currentUser;
    },
    onUser: (listener) =>
      auth.onAuthStateChanged(instance, (user) =>
        listener(user === null ? null : { name: user.displayName }),
      ),
    signIn: async () => {
      await auth.signInWithPopup(instance, new auth.GoogleAuthProvider());
    },
    signOut: () => auth.signOut(instance),
    deleteUser: async () => {
      const user = instance.currentUser;
      if (user === null) return;
      try {
        await auth.deleteUser(user);
      } catch (error) {
        // 前にログインしてから時間がたっていると、消す前にもう一度ログインを求められる
        if ((error as { code?: string }).code !== "auth/requires-recent-login") throw error;
        await auth.reauthenticateWithPopup(user, new auth.GoogleAuthProvider());
        await auth.deleteUser(user);
      }
    },
  };
  return part;
}

export function createAccountClient(
  options: { passcode?: PasscodeHolder; fetch?: typeof fetch } = {},
): AccountClient {
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let configPromise: Promise<AuthConfig> | null = null;
  let firebasePromise: Promise<FirebaseAuthPart> | null = null;

  const passcodeHeaders = (): Record<string, string> => {
    const value = options.passcode?.get() ?? null;
    return value === null ? {} : { [PASSCODE_HEADER]: value };
  };

  const config = () => {
    configPromise ??= fetchImpl("/api/auth/config", { headers: passcodeHeaders() })
      .then(async (response) => {
        const parsed = AuthConfigSchema.safeParse(response.ok ? await response.json() : null);
        return parsed.success ? parsed.data : { enabled: false as const };
      })
      .catch(() => ({ enabled: false as const }));
    // 合言葉を入れる前に断られたら、次に聞き直す
    void configPromise.then((value) => {
      if (!value.enabled) configPromise = null;
    });
    return configPromise;
  };

  /** ログインを用意していれば Firebase を読み込む（一度だけ）。用意していなければ null */
  const firebase = async () => {
    if (firebasePromise === null) {
      const value = await config();
      if (!value.enabled) return null;
      firebasePromise ??= loadFirebase(value);
    }
    return firebasePromise;
  };

  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const user = (await firebase())?.currentUser ?? null;
    if (user === null) throw new TransportError("unauthorized");
    const response = await fetchImpl(path, {
      method: init.method ?? "GET",
      headers: {
        ...passcodeHeaders(),
        Authorization: `Bearer ${await user.getIdToken()}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) throw await errorFromResponse(response, false);
    return response;
  };

  return {
    enabled: async () => (await config()).enabled,
    onUser(listener) {
      let stop: (() => void) | null = null;
      let stopped = false;
      void firebase().then((part) => {
        if (part === null) {
          listener(null);
        } else if (!stopped) {
          stop = part.onUser(listener);
        }
      });
      return () => {
        stopped = true;
        stop?.();
      };
    },
    async signIn() {
      const part = await firebase();
      if (part === null) throw new TransportError("unauthorized");
      await part.signIn();
    },
    async signOut() {
      await (await firebase())?.signOut();
    },
    async listTrips() {
      const response = await call("/api/trips");
      return TripListResponseSchema.parse(await response.json()).trips;
    },
    async saveTrip(sessionId) {
      const response = await call("/api/trips", { method: "POST", body: { sessionId } });
      return TripSummarySchema.parse(await response.json());
    },
    async shareTrip(itineraryId) {
      const response = await call(`/api/trips/${encodeURIComponent(itineraryId)}/share`, {
        method: "POST",
      });
      return ShareResponseSchema.parse(await response.json()).path;
    },
    async deleteTrip(itineraryId) {
      await call(`/api/trips/${encodeURIComponent(itineraryId)}`, { method: "DELETE" });
    },
    async deleteEverything() {
      await call("/api/me/trips", { method: "DELETE" });
      await (await firebase())?.deleteUser();
    },
  };
}
