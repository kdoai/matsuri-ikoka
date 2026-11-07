import {
  type AuthConfig,
  AuthConfigSchema,
  isTrialAccount,
  ShareResponseSchema,
  TripListResponseSchema,
  type TripSummary,
  TripSummarySchema,
} from "@matsuri-ikoka/schema";
import type { Locale } from "../state/types";
import { PASSCODE_HEADER, type PasscodeHolder } from "../transport/server";
import { errorFromResponse, TransportError } from "../transport/types";

// ログインと自分の旅（docs/spec/account.md）。
// ログインは Firebase Authentication（Google と、メールアドレスとパスワード）。Firebase の部品は、ログインを用意しているときだけ読み込む。
// 旅の保存・一覧・共有・削除は接客サーバーの API に、ID トークン（Authorization: Bearer）を付けて頼む。
// ブラウザから Firestore には触らない。

export interface AccountUser {
  /** 利用者の ID。ログアウトや別の人のログインに気づくのに使う */
  id: string;
  /** 画面に出す名前（Google のアカウントの表示名）。なければ null */
  name: string | null;
  /** パスワードでログインできる人か。消す前の確かめ直しと、パスワードの変更の案内を変える */
  usesPassword: boolean;
  /** お試し用のアカウントか。パスワードの変更とアカウントの削除を断る */
  trial: boolean;
}

/** ログインの失敗の種類。画面の文は、メールアドレスの有無が分からないように書く */
export type LoginFailure =
  | "credentials"
  | "sign_up_refused"
  | "weak_password"
  | "invalid_email"
  | "too_many"
  | "popup_blocked"
  | "other_method"
  | "trial"
  /** 旅は消したが、ログインの記録を消せなかった。もう一度消せる */
  | "account_remains"
  /** 利用者がログインの窓を閉じた。文は出さない */
  | "cancelled"
  | "failed";

export class LoginError extends Error {
  constructor(readonly failure: LoginFailure) {
    super(failure);
    this.name = "LoginError";
  }
}

/** Firebase のエラーコードを、失敗の種類に変える */
const FAILURE_OF_CODE: Record<string, LoginFailure> = {
  "auth/invalid-credential": "credentials",
  "auth/invalid-login-credentials": "credentials",
  "auth/wrong-password": "credentials",
  "auth/user-not-found": "credentials",
  "auth/user-disabled": "credentials",
  "auth/user-mismatch": "credentials",
  "auth/email-already-in-use": "sign_up_refused",
  "auth/weak-password": "weak_password",
  "auth/password-does-not-meet-requirements": "weak_password",
  "auth/invalid-email": "invalid_email",
  "auth/missing-email": "invalid_email",
  "auth/too-many-requests": "too_many",
  "auth/popup-blocked": "popup_blocked",
  "auth/account-exists-with-different-credential": "other_method",
  "auth/popup-closed-by-user": "cancelled",
  "auth/cancelled-popup-request": "cancelled",
};

function toLoginError(error: unknown): LoginError {
  if (error instanceof LoginError) return error;
  return new LoginError(FAILURE_OF_CODE[(error as { code?: string }).code ?? ""] ?? "failed");
}

/**
 * ログインの状態の変化を受け、ログインしていた人がいなくなったら（ログアウト・アカウントの削除・別の人のログイン）知らせる。
 * ログインしていない人がログインしたときは知らせない（相談はそのまま続けられる）
 */
export function watchUserLeaving(onLeft: () => void): (user: AccountUser | null) => void {
  let current: string | null = null;
  return (user) => {
    const next = user?.id ?? null;
    if (current !== null && next !== current) onLeft();
    current = next;
  };
}

export interface AccountClient {
  /** ログインを用意しているか */
  enabled(): Promise<boolean>;
  /** ログインの状態が変わるたびに呼ぶ。外すための関数を返す */
  onUser(listener: (user: AccountUser | null) => void): () => void;
  /** Google でログインする。窓を閉じただけなら何もせずに終わる */
  signInWithGoogle(): Promise<void>;
  signInWithPassword(email: string, password: string): Promise<void>;
  /** メールアドレスとパスワードで登録し、そのままログインする */
  signUpWithPassword(email: string, password: string): Promise<void>;
  /** 再設定のメールを、画面の言語で頼む。登録があってもなくても同じように終わる */
  sendPasswordReset(email: string, locale: Locale): Promise<void>;
  /** ログイン中の人のパスワードを変えるメールを、画面の言語で送る。お試し用のアカウントは断る */
  changePassword(locale: Locale): Promise<void>;
  signOut(): Promise<void>;
  listTrips(): Promise<TripSummary[]>;
  /** 相談の旅程を、自分の旅として残す */
  saveTrip(sessionId: string): Promise<TripSummary>;
  /** しおりを30日だけ共有する URL のパス */
  shareTrip(itineraryId: string): Promise<string>;
  /**
   * ログインしていれば ID トークン。していなければ null。
   * 相談をログインした人に結びつけるのに使う。ログインの部品を読み込んでいなければ、読み込まずに null を返す。
   * ログイン中に取れないときは、再試行できるエラーにする（ログインなしとして送ると、持ち主のある相談が 404 になる）
   */
  idToken(): Promise<string | null>;
  /**
   * 自分の旅程のしおりを開くパス。自分の旅程は旅程の ID では開けないので、共有で開く。
   * 同じ内容の共有があれば、サーバーがそれを返す。
   * ログインしていない・自分の旅程でなければ null（旅程の ID のまま開ける）
   */
  ownShioriPath(itineraryId: string): Promise<string | null>;
  deleteTrip(itineraryId: string): Promise<void>;
  /**
   * 本人を確かめ直してから、自分の旅をすべて消し、ログインの記録（Firebase のアカウント）も消してログアウトする。
   * password はパスワードの人だけが渡す。確かめられなければ何も消さない。お試し用のアカウントは断る。
   * Google の確かめ直しは窓を開くので、利用者が押したボタンの処理からすぐに呼ぶ
   */
  deleteEverything(password?: string): Promise<void>;
}

/** Firebase の Auth のうち、ここで使う部分 */
interface FirebaseAuthPart {
  currentUser: { uid: string; getIdToken(): Promise<string> } | null;
  onUser(listener: (user: AccountUser | null) => void): () => void;
  signInWithGoogle(): Promise<void>;
  signInWithPassword(email: string, password: string): Promise<void>;
  signUpWithPassword(email: string, password: string): Promise<void>;
  sendPasswordReset(email: string, locale: Locale): Promise<void>;
  changePassword(locale: Locale): Promise<void>;
  signOut(): Promise<void>;
  reauthenticate(password: string | undefined): Promise<void>;
  deleteUser(): Promise<void>;
}

/** Firebase の EmailAuthProvider.PROVIDER_ID */
const PASSWORD_PROVIDER = "password";

function accountUserOf(user: {
  uid: string;
  displayName: string | null;
  providerData: { providerId: string }[];
}): AccountUser {
  return {
    id: user.uid,
    name: user.displayName,
    usesPassword: user.providerData.some((p) => p.providerId === PASSWORD_PROVIDER),
    trial: isTrialAccount(user.uid),
  };
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
        listener(user === null ? null : accountUserOf(user)),
      ),
    signInWithGoogle: async () => {
      await auth.signInWithPopup(instance, new auth.GoogleAuthProvider());
    },
    signInWithPassword: async (email, password) => {
      await auth.signInWithEmailAndPassword(instance, email, password);
    },
    signUpWithPassword: async (email, password) => {
      await auth.createUserWithEmailAndPassword(instance, email, password);
    },
    sendPasswordReset: async (email, locale) => {
      instance.languageCode = locale;
      try {
        await auth.sendPasswordResetEmail(instance, email);
      } catch (error) {
        // 登録がないことを見せない（メールアドレスの有無を隠す設定を入れる前でも同じに見せる）
        if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
      }
    },
    changePassword: async (locale) => {
      const email = instance.currentUser?.email;
      if (!email) throw new LoginError("failed");
      instance.languageCode = locale;
      await auth.sendPasswordResetEmail(instance, email);
    },
    signOut: () => auth.signOut(instance),
    reauthenticate: async (password) => {
      const user = instance.currentUser;
      if (user === null) throw new LoginError("failed");
      if (!accountUserOf(user).usesPassword) {
        await auth.reauthenticateWithPopup(user, new auth.GoogleAuthProvider());
        return;
      }
      if (!password || !user.email) throw new LoginError("credentials");
      await auth.reauthenticateWithCredential(
        user,
        auth.EmailAuthProvider.credential(user.email, password),
      );
    },
    deleteUser: async () => {
      const user = instance.currentUser;
      if (user !== null) await auth.deleteUser(user);
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

  /** ログインの部品を読み込んで渡し、失敗を LoginError にする。用意していなければ断る */
  const withFirebase = async <T>(task: (part: FirebaseAuthPart) => Promise<T>): Promise<T> => {
    const part = await firebase();
    if (part === null) throw new TransportError("unauthorized");
    try {
      return await task(part);
    } catch (error) {
      // サーバーの断り（TransportError）は、そのまま返す
      throw error instanceof TransportError ? error : toLoginError(error);
    }
  };

  /** お試し用のアカウントでは断る操作の前に呼ぶ */
  const refuseTrial = (part: FirebaseAuthPart) => {
    if (part.currentUser !== null && isTrialAccount(part.currentUser.uid)) {
      throw new LoginError("trial");
    }
  };

  const shareTrip = async (itineraryId: string) => {
    const response = await call(`/api/trips/${encodeURIComponent(itineraryId)}/share`, {
      method: "POST",
    });
    return ShareResponseSchema.parse(await response.json()).path;
  };

  const idToken = async (): Promise<string | null> => {
    if (firebasePromise === null) return null;
    let part: FirebaseAuthPart;
    try {
      part = await firebasePromise;
    } catch {
      // ログインの部品を読み込めなければ、ログインしていない
      return null;
    }
    const user = part.currentUser;
    if (user === null) return null;
    try {
      return await user.getIdToken();
    } catch {
      throw new TransportError("connection_lost");
    }
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
    async signInWithGoogle() {
      try {
        await withFirebase((part) => part.signInWithGoogle());
      } catch (error) {
        if (!(error instanceof LoginError && error.failure === "cancelled")) throw error;
      }
    },
    signInWithPassword: (email, password) =>
      withFirebase((part) => part.signInWithPassword(email, password)),
    signUpWithPassword: (email, password) =>
      withFirebase((part) => part.signUpWithPassword(email, password)),
    sendPasswordReset: (email, locale) =>
      withFirebase((part) => part.sendPasswordReset(email, locale)),
    changePassword: (locale) =>
      withFirebase(async (part) => {
        refuseTrial(part);
        await part.changePassword(locale);
      }),
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
    shareTrip,
    idToken,
    async ownShioriPath(itineraryId) {
      if ((await idToken()) === null) return null;
      try {
        return await shareTrip(itineraryId);
      } catch (error) {
        // ログインする前に組んだ、持ち主のない旅程は、旅程の ID のまま開ける
        if (error instanceof TransportError && error.status === 404) return null;
        throw error;
      }
    },
    async deleteTrip(itineraryId) {
      await call(`/api/trips/${encodeURIComponent(itineraryId)}`, { method: "DELETE" });
    },
    deleteEverything: (password) =>
      withFirebase(async (part) => {
        refuseTrial(part);
        // 先に確かめ直す。通信のあとに窓を開くとブラウザに止められ、旅だけが消えてアカウントが残ることがある
        await part.reauthenticate(password);
        await call("/api/me/trips", { method: "DELETE" });
        try {
          await part.deleteUser();
        } catch {
          throw new LoginError("account_remains");
        }
      }),
  };
}
