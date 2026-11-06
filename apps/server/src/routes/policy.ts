import type { Context, Hono, MiddlewareHandler } from "hono";
import { type IdTokenVerifier, requestOwner } from "../account/idToken";
import type { InternalAuthKind, InternalCaller, InternalVerifiers } from "../account/internalAuth";
import type { Consultations } from "../session/consultations";
import type { StoragePersistence } from "../session/persistence";
import type { Session } from "../session/sessionStore";
import type { OwnerId } from "../storage/owner";
import type { OwnerTripStorage } from "../storage/types";
import { apiError } from "./errors";

// 既定で断る API（docs/spec/api.md の「経路と認可の決まり」）。
// 経路はここからしか足せず、足すときに必ず決まりを宣言する。決まりごとに、ハンドラに渡すものを変える：
// - public：だれでも。利用者のデータには触れない（ID そのものが鍵になる共有のしおりを除く）
// - consultation：相談の持ち主。相談は open でしか受け取れない。ない相談もほかの人の相談も同じ結果になる
// - owner：ログインした持ち主。その人に絞った保存の口だけを受け取る
// - internal：内部の呼び出し。検証を通った呼び出し元だけが届く
// 宣言のない経路があると、seal() が起動の時点で止める（テストと、デプロイの前のモックの確かめで見つかる）。

export const ROUTE_POLICIES = ["public", "consultation", "owner", "internal"] as const;
export type RoutePolicy = (typeof ROUTE_POLICIES)[number];

export type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface DeclaredRoute {
  method: RouteMethod;
  path: string;
  policy: RoutePolicy;
}

type Reply = Response | Promise<Response>;

export interface PublicAccess {
  /** ログインしていれば、確かめた利用者。必要なときだけトークンを確かめる */
  viewer(): Promise<OwnerId | null>;
}

export interface ConsultationAccess {
  /** ログインしていれば、確かめた利用者 */
  viewer: OwnerId | null;
  /** 相談を開く。ない相談も、ほかの人の相談も undefined */
  open(sessionId: string): Promise<Session | undefined>;
}

export interface OwnerAccess {
  owner: OwnerId;
  /** この人に絞った保存の口 */
  trips: OwnerTripStorage;
  /** 相談を開く。ない相談も、ほかの人の相談も undefined */
  open(sessionId: string): Promise<Session | undefined>;
}

export interface RouteGuards {
  /** ログインを用意していなければ null */
  verifier: IdTokenVerifier | null;
  persistence: StoragePersistence;
  consultations: Consultations;
  /** 内部の入口の検証。設定のないものは省く */
  internal?: InternalVerifiers;
}

/** 経路の値（ハンドラを包むと、Hono の型からは経路の名前が分からなくなるので、ここで文字列にする） */
export const routeParam = (c: Context, name: string): string => c.req.param(name) ?? "";

export class UndeclaredRouteError extends Error {}

export class SecureRoutes {
  readonly #app: Hono;
  readonly #guards: RouteGuards;
  readonly #declared: DeclaredRoute[] = [];
  /** ここを通して足したハンドラ。宣言のない経路を見つけるのに使う */
  readonly #known = new Set<unknown>();

  constructor(app: Hono, guards: RouteGuards) {
    this.#app = app;
    this.#guards = guards;
  }

  /** 宣言した経路の一覧（足した順） */
  get declared(): readonly DeclaredRoute[] {
    return this.#declared;
  }

  #add(method: RouteMethod, path: string, policy: RoutePolicy, handler: MiddlewareHandler): void {
    this.#declared.push({ method, path, policy });
    this.#known.add(handler);
    this.#app.on(method, path, handler);
  }

  /** 経路の前に挟む処理（合言葉・本文の上限・見出し） */
  use(path: string, middleware: MiddlewareHandler): void {
    this.#known.add(middleware);
    this.#app.use(path, middleware);
  }

  /** だれでも読める画面のファイル。次の処理へ渡せるので、経路とは別に足す */
  files(path: string, handler: MiddlewareHandler, method?: "GET"): void {
    if (method === undefined) {
      this.use(path, handler);
    } else {
      this.#add(method, path, "public", handler);
    }
  }

  public(
    method: RouteMethod,
    path: string,
    handler: (c: Context, access: PublicAccess) => Reply,
  ): void {
    this.#add(method, path, "public", async (c) =>
      handler(c, { viewer: () => requestOwner(c, this.#guards.verifier) }),
    );
  }

  consultation(
    method: RouteMethod,
    path: string,
    handler: (c: Context, access: ConsultationAccess) => Reply,
  ): void {
    this.#add(method, path, "consultation", async (c) => {
      const viewer = await requestOwner(c, this.#guards.verifier);
      return handler(c, {
        viewer,
        open: (sessionId) => this.#guards.consultations.open(sessionId, viewer),
      });
    });
  }

  owner(
    method: RouteMethod,
    path: string,
    handler: (c: Context, access: OwnerAccess) => Reply,
  ): void {
    this.#add(method, path, "owner", async (c) => {
      if (this.#guards.verifier === null) {
        return c.json(apiError("bad_request", "ログインは用意していません。", false), 404);
      }
      const owner = await requestOwner(c, this.#guards.verifier);
      if (owner === null) {
        return c.json(apiError("unauthorized", "ログインしてください。", false), 401);
      }
      c.header("Cache-Control", "private, no-store");
      return handler(c, {
        owner,
        trips: this.#guards.persistence.forOwner(owner),
        open: (sessionId) => this.#guards.consultations.open(sessionId, owner),
      });
    });
  }

  /**
   * 内部の入口。合言葉の外に置き（/internal/…）、kind の検証を通ったものだけを通す。
   * 検証の設定がなければ、この入口だけが断る
   */
  internal(
    method: RouteMethod,
    path: string,
    kind: InternalAuthKind,
    handler: (c: Context, caller: InternalCaller) => Reply,
  ): void {
    this.#add(method, path, "internal", async (c) => {
      const verifier = this.#guards.internal?.[kind];
      if (verifier === undefined) {
        return c.json(apiError("bad_request", "見つかりません。", false), 404);
      }
      const caller = await verifier.verify(c);
      if (caller === null) {
        return c.json(apiError("unauthorized", "確かめられませんでした。", false), 401);
      }
      c.header("Cache-Control", "no-store");
      return handler(c, caller);
    });
  }

  /** ここを通さずに足した経路があれば、起動を止める */
  seal(): void {
    const undeclared = this.#app.routes.filter((route) => !this.#known.has(route.handler));
    if (undeclared.length > 0) {
      const names = undeclared.map((route) => `${route.method} ${route.path}`).join("、");
      throw new UndeclaredRouteError(`認可の決まりを宣言していない経路があります：${names}`);
    }
  }
}
