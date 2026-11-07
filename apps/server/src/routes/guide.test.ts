import { fileURLToPath } from "node:url";
import {
  DEFAULT_PREFERENCES,
  decodeGuideSseEvent,
  type GuideMemoItem,
  type GuideSseEvent,
  GuideStateResponseSchema,
  type SampleConversation,
  type SampleGuide,
  SessionResponseSchema,
} from "@matsuri-ikoka/schema";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdTokenVerifier } from "../account/idToken";
import { loadSampleConversations, ReplayAgentRunner } from "../agent/replayRunner";
import { type AppDeps, createApp } from "../app";
import { type FestivalStore, loadFestivals } from "../data/festivalStore";
import { proposalContentHash } from "../guide/proposal";
import { loadSampleGuides, ReplayGuideRunner } from "../guide/replayRunner";
import type { GuideRunner } from "../guide/runner";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { MemoryTripStorage } from "../storage/memory";
import { type OwnerId, ownerIdOf } from "../storage/owner";
import type { OwnerTripStorage, SharedItinerary } from "../storage/types";
import { ConcurrencyLimiter, DailyLimiter } from "./guard";

// ガイドの API を、架空の祭りのサンプルの相談で通して確かめる。モデルも外のサービスも呼ばない。

const root = (relative: string) =>
  fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));

let conversations: SampleConversation[];
let guides: SampleGuide[];
let festivals: FestivalStore;

beforeAll(async () => {
  conversations = await loadSampleConversations(root("data/samples/conversations"));
  guides = await loadSampleGuides(root("data/samples/guide"));
  festivals = (await loadFestivals([root("data/samples/festivals")])).store;
});

const fakeVerifier: IdTokenVerifier = {
  async verify(token) {
    const uid = token.startsWith("token-") ? token.slice("token-".length) : "";
    return uid === "" ? null : uid;
  },
};

const ALICE = "alice";
const BOB = "bob";

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(overrides: Partial<AppDeps> & { noGuide?: boolean } = {}) {
  const { noGuide, ...deps } = overrides;
  const itineraries = deps.itineraries ?? new ItineraryStore();
  const sessions = deps.sessions ?? new SessionStore();
  const storage = (deps.storage as MemoryTripStorage | undefined) ?? new MemoryTripStorage();
  const app = createApp({
    runner: new ReplayAgentRunner(conversations, itineraries, { speed: 0 }),
    limiter: new DailyLimiter(null, () => "2026-08-03"),
    festivals,
    accessPasscode: null,
    verifier: fakeVerifier,
    authConfig: { enabled: true, apiKey: "k", authDomain: "example.com", projectId: "demo" },
    ...(noGuide ? {} : { guide: { runner: new ReplayGuideRunner(guides, { speed: 0 }) } }),
    ...deps,
    itineraries,
    sessions,
    storage,
  });
  const call = (path: string, init: { method?: string; user?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(init.user === undefined ? {} : { authorization: `Bearer token-${init.user}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  /** サンプルの相談を最後まで流し、旅程のある相談にする */
  const consult = async (user?: string) => {
    const created = await call("/api/session", { body: {}, ...(user ? { user } : {}) });
    const { sessionId } = (await created.json()) as { sessionId: string };
    for (const _ of conversations[0]?.turns ?? []) {
      await (
        await call("/api/chat", {
          body: { sessionId, message: "こんにちは", preferences: DEFAULT_PREFERENCES },
          ...(user ? { user } : {}),
        })
      ).text();
    }
    const itineraryId = sessions.get(sessionId)?.itineraryId;
    if (!itineraryId) throw new Error("旅程がありません");
    return { sessionId, itineraryId };
  };
  const chat = (sessionId: string, message: string, user?: string, extra: object = {}) =>
    call("/api/guide/chat", {
      body: { sessionId, message, ...extra },
      ...(user ? { user } : {}),
    });
  const state = async (sessionId: string, user?: string) => {
    const res = await call("/api/guide/state", {
      body: { sessionId },
      ...(user ? { user } : {}),
    });
    expect(res.status).toBe(200);
    return GuideStateResponseSchema.parse(await res.json());
  };
  return { app, call, consult, chat, state, sessions, itineraries, storage };
}

async function readEvents(res: Response): Promise<GuideSseEvent[]> {
  const events: GuideSseEvent[] = [];
  for (const block of (await res.text()).split(/\n\n/)) {
    const lines = block.split("\n").filter(Boolean);
    const event = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (event) events.push(decodeGuideSseEvent({ event, data }));
  }
  return events;
}

/** 読み取りが止まる・失敗する・読めない形を返す保存の口 */
class TroubledStorage extends MemoryTripStorage {
  readonly stalled = new Set<string>();
  failing = false;
  broken = false;

  #read<T>(name: string, work: () => Promise<T>): Promise<T> {
    return this.stalled.has(name) ? new Promise<T>(() => {}) : work();
  }

  override getSession(id: string) {
    return this.#read("getSession", () => super.getSession(id));
  }

  override async readUnowned(id: string): Promise<SharedItinerary | null> {
    if (this.failing) throw new Error("保存の口の失敗");
    const found = await this.#read("readUnowned", () => super.readUnowned(id));
    return found !== null && this.broken ? { ...found, itinerary: { broken: true } } : found;
  }

  override forOwner(owner: OwnerId): OwnerTripStorage {
    const trips = super.forOwner(owner);
    return {
      ...trips,
      readGuideUsage: (tripId, day) =>
        this.#read("readGuideUsage", () => trips.readGuideUsage(tripId, day)),
      tripDocs: (tripId) => {
        const docs = trips.tripDocs(tripId);
        return { ...docs, list: (kind) => this.#read("docs.list", () => docs.list(kind)) };
      },
    };
  }
}

const MEMO_MESSAGE = "連れは歩くのがゆっくりなので、気にしてもらえますか";
const EMERGENCY_MESSAGE = "連れが倒れて、呼びかけても返事がありません";

/** 手帳に項目を残し、その項目を返す */
async function saveMemo(
  context: ReturnType<typeof setup>,
  sessionId: string,
  user?: string,
): Promise<GuideMemoItem> {
  const events = await readEvents(await context.chat(sessionId, MEMO_MESSAGE, user));
  const memo = events.find((event) => event.type === "guide.memo");
  if (memo?.type !== "guide.memo") throw new Error("手帳に残りませんでした");
  return memo.data.item;
}

describe("ガイドを用意していないとき", () => {
  it("ガイドの入口だけが断り、今の相談は動く", async () => {
    const context = setup({ noGuide: true });
    const { sessionId, itineraryId } = await context.consult();

    for (const [path, body] of [
      ["/api/guide/state", { sessionId }],
      ["/api/guide/chat", { sessionId, message: "こんにちは" }],
      ["/api/guide/memo/m-1", { sessionId, text: "ゆっくり" }],
      ["/api/guide/memo/m-1/delete", { sessionId }],
    ] as const) {
      expect((await context.call(path, { body })).status, path).toBe(404);
    }
    expect(
      (await context.call("/api/guide/open", { user: ALICE, body: { tripId: itineraryId } }))
        .status,
    ).toBe(404);
    expect((await context.call("/health", { method: "GET" })).status).toBe(200);
    expect((await context.call(`/api/itinerary/${itineraryId}`, { method: "GET" })).status).toBe(
      200,
    );
  });
});

describe("POST /api/guide/state", () => {
  it("旅の時期・見回り・通知・承認待ちの提案・手帳を返す。記録の旅はこの相談の旅に置き換える", async () => {
    const context = setup();
    const { sessionId, itineraryId } = await context.consult();

    const state = await context.state(sessionId);

    expect(state.tripId).toBe(itineraryId);
    expect(state.phase).toBe("before");
    expect(state.watch?.tripId).toBe(itineraryId);
    expect(state.notices.map((notice) => notice.tripId)).toEqual([itineraryId]);
    const [proposal] = state.proposals;
    expect(proposal?.tripId).toBe(itineraryId);
    expect(proposal?.itinerary.id).toBe(itineraryId);
    expect(proposal?.baseVersion).toBe(state.version);
    expect(proposal?.contentHash).toBe(proposalContentHash(proposal?.itinerary ?? ({} as never)));
    expect(state.memo).toEqual([]);
  });

  it("旅程がまだない相談は 409、ない相談は 404、形が違えば 400", async () => {
    const context = setup();
    const created = await context.call("/api/session", { body: {} });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const noTrip = await context.call("/api/guide/state", { body: { sessionId } });
    const missing = await context.call("/api/guide/state", { body: { sessionId: "s-none" } });
    const invalid = await context.call("/api/guide/state", {
      body: { sessionId, tripId: "trip-other" },
    });

    expect(noTrip.status).toBe(409);
    expect(missing.status).toBe(404);
    expect(invalid.status).toBe(400);
  });
});

describe("POST /api/guide/chat", () => {
  it("記録を流し、最後に必ず guide.done を送り、旅程は変えない", async () => {
    const context = setup();
    const { sessionId, itineraryId } = await context.consult();
    const before = context.itineraries.get(itineraryId);

    const res = await context.chat(sessionId, "留守の間に、何か変わったことはありましたか");
    const events = await readEvents(res);

    expect(res.status).toBe(200);
    expect(events.at(-1)).toEqual({
      type: "guide.done",
      data: { phase: "before", unreadNotices: 1, pendingProposals: 1 },
    });
    expect(events.filter((event) => event.type === "guide.done")).toHaveLength(1);
    const proposal = events.find((event) => event.type === "guide.proposal");
    expect(proposal?.type === "guide.proposal" && proposal.data.proposal.tripId).toBe(itineraryId);
    expect(context.itineraries.get(itineraryId)).toEqual(before);
    expect(context.sessions.get(sessionId)?.guide.resume.turns).toBe(1);
    expect(context.sessions.get(sessionId)?.guide.resume.topics).toContain("festival");
  });

  it("緊急の相談では、公的な連絡先を返答の文より先に、1回だけ出す", async () => {
    const context = setup();
    const { sessionId } = await context.consult();

    const events = await readEvents(await context.chat(sessionId, EMERGENCY_MESSAGE));

    expect(events[0]).toEqual({
      type: "guide.emergency",
      data: {
        contacts: [
          { service: "ambulance_fire", number: "119" },
          { service: "police", number: "110" },
        ],
      },
    });
    expect(events.filter((event) => event.type === "guide.emergency")).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("message.delta");
    expect(context.sessions.get(sessionId)?.guide.resume.topics).toContain("trouble");
  });

  it("緊急でない相談には、連絡先を出さない", async () => {
    const context = setup();
    const { sessionId } = await context.consult();

    const events = await readEvents(
      await context.chat(sessionId, "雨が降ったらどうすればいいですか"),
    );

    expect(events.map((event) => event.type)).not.toContain("guide.emergency");
  });

  it("返事を作れなくても、緊急の相談には連絡先と決まった文を返し、もう一度送る案内も添える", async () => {
    const failing: GuideRunner = {
      mode: "live",
      today: () => "2026-08-03",
      now: () => "2026-08-03T10:00:00+09:00",
      runTurn: async () => {
        throw new Error("通じない");
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const context = setup({ guide: { runner: failing } });
    const { sessionId } = await context.consult();

    const events = await readEvents(await context.chat(sessionId, EMERGENCY_MESSAGE));

    expect(events.map((event) => event.type)).toEqual([
      "guide.emergency",
      "message.delta",
      "error",
      "guide.done",
    ]);
    expect(events[2]).toMatchObject({ type: "error", data: { retryable: true } });
    expect(JSON.stringify(events[2])).toContain("もう一度");
  });

  it("緊急の発言が時間切れになったら、決まった文のあとに、もう一度送る案内を添える", async () => {
    const hanging: GuideRunner = {
      mode: "live",
      today: () => "2026-08-03",
      now: () => "2026-08-03T10:00:00+09:00",
      runTurn: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const context = setup({ guide: { runner: hanging }, turnIdleMs: 5 });
    const { sessionId } = await context.consult();

    const events = await readEvents(await context.chat(sessionId, EMERGENCY_MESSAGE));

    expect(events.map((event) => event.type)).toEqual([
      "guide.emergency",
      "message.delta",
      "error",
      "guide.done",
    ]);
    expect(JSON.stringify(events[1])).toContain("119");
    expect(events[2]).toMatchObject({ type: "error", data: { code: "timeout", retryable: true } });
  });

  it("緊急でない発言の時間切れは、いままでどおり error で知らせる", async () => {
    const hanging: GuideRunner = {
      mode: "live",
      today: () => "2026-08-03",
      now: () => "2026-08-03T10:00:00+09:00",
      runTurn: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const context = setup({ guide: { runner: hanging }, turnIdleMs: 5 });
    const { sessionId } = await context.consult();

    const events = await readEvents(await context.chat(sessionId, "こんにちは"));

    expect(events.map((event) => event.type)).toEqual(["error", "guide.done"]);
  });

  describe("相談や旅を開けないときの緊急の相談", () => {
    /** 乱数の返答の ID をならして、応答を比べられるようにする */
    const shape = (events: GuideSseEvent[]) =>
      JSON.stringify(events).replaceAll(/emergency-[A-Za-z0-9_-]+/g, "emergency-id");

    it("ない相談でも、連絡先と決まった文を返し、新しく始める案内も添える", async () => {
      const context = setup();

      const res = await context.chat("s-expired", EMERGENCY_MESSAGE);
      const events = await readEvents(res);

      expect(res.status).toBe(200);
      expect(events.map((event) => event.type)).toEqual([
        "guide.emergency",
        "message.delta",
        "error",
        "guide.done",
      ]);
      expect(events[0]).toMatchObject({ type: "guide.emergency" });
      expect(JSON.stringify(events[2])).toContain("新しく始めて");
    });

    it("ほかの人の相談でも同じ応答で、相談の中身を見せない", async () => {
      const context = setup();
      const { sessionId, itineraryId } = await context.consult(ALICE);
      await saveMemo(context, sessionId, ALICE);

      const others = await readEvents(await context.chat(sessionId, EMERGENCY_MESSAGE, BOB));
      const missing = await readEvents(await context.chat("s-none", EMERGENCY_MESSAGE, BOB));

      expect(shape(others)).toBe(shape(missing));
      expect(JSON.stringify(others)).not.toContain(itineraryId);
      expect(context.sessions.get(sessionId)?.guide.resume.turns).toBe(1);
    });

    it("相談に旅程がないとき、旅が消されたときも、連絡先を返す", async () => {
      const context = setup();
      const created = await context.call("/api/session", { body: {} });
      const { sessionId: empty } = (await created.json()) as { sessionId: string };
      const kept = await context.consult(ALICE);
      await context.call(`/api/trips/${kept.itineraryId}`, { method: "DELETE", user: ALICE });

      for (const [sessionId, user] of [
        [empty, undefined],
        [kept.sessionId, ALICE],
      ] as const) {
        const res = await context.chat(sessionId, EMERGENCY_MESSAGE, user);
        expect(res.status, sessionId).toBe(200);
        expect((await readEvents(res))[0]?.type, sessionId).toBe("guide.emergency");
      }
    });

    it("保存の口が失敗しても、連絡先を返す", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const context = setup({
        guide: {
          runner: {
            mode: "live",
            today: () => "2026-08-03",
            now: () => "2026-08-03T10:00:00+09:00",
            prepare: async () => {
              throw new Error("保存の口の失敗");
            },
            runTurn: async () => {},
          },
        },
      });
      const { sessionId } = await context.consult();

      const res = await context.chat(sessionId, EMERGENCY_MESSAGE);

      expect(res.status).toBe(200);
      expect((await readEvents(res))[0]?.type).toBe("guide.emergency");
    });

    it("保存の口が止まっていても、待たずに連絡先を送る", async () => {
      const storage = new TroubledStorage();
      storage.stalled.add("getSession");
      const context = setup({ storage, emergencyWaitMs: 60_000 });

      const res = await context.chat("s-elsewhere", EMERGENCY_MESSAGE);
      const reader = res.body?.getReader();
      const first = await reader?.read();

      expect(res.status).toBe(200);
      expect(new TextDecoder().decode(first?.value)).toContain("guide.emergency");
      await reader?.cancel();
    });

    it.each([
      ["相談", "getSession", undefined],
      ["旅", "readUnowned", undefined],
      ["使った量", "readGuideUsage", ALICE],
    ])(
      "%sの読み取りが止まっても、待つのをやめて、もう一度送る案内で閉じる",
      async (_name, name, user) => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const storage = new TroubledStorage();
        const context = setup({ storage, emergencyWaitMs: 5 });
        const { sessionId } = await context.consult(user);
        storage.stalled.add(name);
        // 相談の読み取りは、相談が手元にない別のインスタンスから試す
        const elsewhere = name === "getSession" ? setup({ storage, emergencyWaitMs: 5 }) : context;

        const res = await elsewhere.chat(sessionId, EMERGENCY_MESSAGE, user);
        const events = await readEvents(res);

        expect(events.map((event) => event.type)).toEqual([
          "guide.emergency",
          "message.delta",
          "error",
          "guide.done",
        ]);
        expect(events[2]).toMatchObject({ type: "error", data: { retryable: true } });
        expect(context.sessions.get(sessionId)?.busy ?? false).toBe(false);
      },
    );

    it("緊急でない発言は、いままでどおり断る", async () => {
      const context = setup();
      const created = await context.call("/api/session", { body: {} });
      const { sessionId } = (await created.json()) as { sessionId: string };

      expect((await context.chat("s-none", "こんにちは")).status).toBe(404);
      expect((await context.chat(sessionId, "こんにちは")).status).toBe(409);
    });
  });

  it("緊急でない相談で返事を作れなければ、error のあと guide.done で閉じる", async () => {
    const failing: GuideRunner = {
      mode: "live",
      today: () => "2026-08-03",
      now: () => "2026-08-03T10:00:00+09:00",
      runTurn: async () => {
        throw new Error("通じない");
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const context = setup({ guide: { runner: failing } });
    const { sessionId } = await context.consult();

    const events = await readEvents(await context.chat(sessionId, "こんにちは"));

    expect(events.map((event) => event.type)).toEqual(["error", "guide.done"]);
  });

  it("旅や利用者を本文で指定しようとしたら断る", async () => {
    const context = setup();
    const { sessionId } = await context.consult();

    for (const extra of [{ tripId: "trip-other" }, { ownerUid: BOB }, { resume: "sdk-other" }]) {
      const res = await context.chat(sessionId, "こんにちは", undefined, extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it("前の返事を作っている途中は 409 で断るが、緊急の連絡先は返す", async () => {
    const context = setup();
    const { sessionId } = await context.consult();
    const session = context.sessions.get(sessionId);
    if (session === undefined) throw new Error("相談がありません");
    session.busy = true;

    expect((await context.chat(sessionId, "こんにちは")).status).toBe(409);
    const res = await context.chat(sessionId, EMERGENCY_MESSAGE);

    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(events.map((event) => event.type)).toEqual([
      "guide.emergency",
      "message.delta",
      "error",
      "guide.done",
    ]);
    expect(JSON.stringify(events[2])).toContain("前の返事");
    expect(session.busy).toBe(true);
  });

  it("現在地を、保存の口にも相談の状態にも残さない", async () => {
    const context = setup();
    const { sessionId } = await context.consult();

    await (
      await context.chat(sessionId, "近くで食べられますか", undefined, {
        location: { lat: 35.1234, lng: 136.5678 },
      })
    ).text();

    const saved = await context.storage.getSession(sessionId);
    expect(JSON.stringify(saved)).not.toContain("35.1234");
    expect(JSON.stringify(context.sessions.get(sessionId)?.guide)).not.toContain("35.1234");
  });

  it("発言の本文と現在地をログに残さない", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const context = setup();
    const { sessionId } = await context.consult();

    await (
      await context.chat(sessionId, "ひみつの発言7f3a", undefined, {
        location: { lat: 35.1234, lng: 136.5678 },
      })
    ).text();

    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain("ひみつの発言7f3a");
    expect(logged.join("\n")).not.toContain("35.1234");
  });
});

describe("費用と回数の上限", () => {
  const limits = { turnsPerUser: 10, turnsPerTrip: 1, costUsdPerUser: 10, costUsdPerTrip: 10 };
  const guide = () => ({ runner: new ReplayGuideRunner(guides, { speed: 0 }), limits });

  it("旅ごとの回数の上限に達したら rate_limited で断り、緊急の連絡先は返す", async () => {
    const context = setup({ guide: guide() });
    const { sessionId } = await context.consult();

    await (await context.chat(sessionId, "こんにちは")).text();
    const refused = await context.chat(sessionId, "こんにちは");
    const emergency = await context.chat(sessionId, EMERGENCY_MESSAGE);

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "rate_limited", retryable: false });
    expect(emergency.status).toBe(200);
    const events = await readEvents(emergency);
    expect(events.map((event) => event.type)).toEqual([
      "guide.emergency",
      "message.delta",
      "error",
      "guide.done",
    ]);
    expect(events[2]).toMatchObject({ type: "error", data: { code: "rate_limited" } });
    expect(JSON.stringify(events[2])).toContain("また明日");
  });

  it("ログインしている人の分は保存の口に残し、別のインスタンスでも数える", async () => {
    const storage = new MemoryTripStorage();
    const first = setup({ storage, guide: guide() });
    const { sessionId } = await first.consult(ALICE);
    await (await first.chat(sessionId, "こんにちは", ALICE)).text();

    const second = setup({ storage, guide: guide() });

    expect((await second.chat(sessionId, "こんにちは", ALICE)).status).toBe(429);
    const usage = await storage
      .forOwner(ownerIdOf(ALICE))
      .readGuideUsage(first.sessions.get(sessionId)?.itineraryId ?? "", guides[0]?.today ?? "");
    expect(usage.user.turns).toBe(1);
    expect(usage.trip.turns).toBe(1);
  });

  it("利用者ごとの費用の上限は、旅をまたいで効く", async () => {
    const context = setup({
      guide: {
        runner: {
          mode: "mock",
          today: () => "2026-08-03",
          now: () => "2026-08-03T10:00:00+09:00",
          runTurn: async ({ meter }) => {
            meter.add(1.5);
          },
        },
        limits: { turnsPerUser: 10, turnsPerTrip: 10, costUsdPerUser: 1, costUsdPerTrip: 10 },
      },
      // 利用者ごとの枠だけを見るので、利用者ごとに別の IP にする
      clientIp: (c) => c.req.header("authorization") ?? "anonymous",
    });
    const first = await context.consult(ALICE);
    const second = await context.consult(ALICE);

    await (await context.chat(first.sessionId, "こんにちは", ALICE)).text();

    expect((await context.chat(second.sessionId, "こんにちは", ALICE)).status).toBe(429);
    const other = await context.consult(BOB);
    expect((await context.chat(other.sessionId, "こんにちは", BOB)).status).toBe(200);
  });

  it("同じ IP の別の人にも、費用の上限が効く（登録し直しても回避できない）", async () => {
    const context = setup({
      guide: {
        runner: {
          mode: "mock",
          today: () => "2026-08-03",
          now: () => "2026-08-03T10:00:00+09:00",
          runTurn: async ({ meter }) => {
            meter.add(1.5);
          },
        },
        limits: { turnsPerUser: 10, turnsPerTrip: 10, costUsdPerUser: 1, costUsdPerTrip: 10 },
      },
    });
    const first = await context.consult(ALICE);
    const other = await context.consult(BOB);

    await (await context.chat(first.sessionId, "こんにちは", ALICE)).text();

    expect((await context.chat(other.sessionId, "こんにちは", BOB)).status).toBe(429);
  });

  it("その発言に使える費用を、今日の残りまでに抑える", async () => {
    const budgets: number[] = [];
    const context = setup({
      guide: {
        runner: {
          mode: "mock",
          today: () => "2026-08-03",
          now: () => "2026-08-03T10:00:00+09:00",
          maxBudgetUsd: 5,
          runTurn: async ({ meter, budgetUsd }) => {
            budgets.push(budgetUsd);
            meter.add(0.75);
          },
        },
        limits: { turnsPerUser: 10, turnsPerTrip: 10, costUsdPerUser: 2, costUsdPerTrip: 1 },
      },
    });
    const { sessionId } = await context.consult(ALICE);

    await (await context.chat(sessionId, "こんにちは", ALICE)).text();
    await (await context.chat(sessionId, "こんにちは", ALICE)).text();

    expect(budgets).toEqual([1, 0.25]);
  });

  it("ツールの中の調べに使える費用を、今日の残りで抑える", async () => {
    const remaining: (number | null)[] = [];
    const context = setup({
      guide: {
        runner: {
          mode: "mock",
          today: () => "2026-08-03",
          now: () => "2026-08-03T10:00:00+09:00",
          maxBudgetUsd: 0.1,
          runTurn: async ({ meter }) => {
            remaining.push(meter.remainingUsd);
            meter.add(0.75);
          },
        },
        limits: { turnsPerUser: 10, turnsPerTrip: 10, costUsdPerUser: 2, costUsdPerTrip: 1 },
      },
    });
    const { sessionId } = await context.consult(ALICE);

    await (await context.chat(sessionId, "こんにちは", ALICE)).text();
    await (await context.chat(sessionId, "こんにちは", ALICE)).text();

    expect(remaining).toEqual([1, 0.25]);
  });

  it("全体の1日の回数の上限も使う", async () => {
    const limiter = new DailyLimiter(null, () => "2026-08-03");
    const context = setup({ limiter });
    const { sessionId } = await context.consult();
    const refusing = new DailyLimiter(0, () => "2026-08-03");
    const limited = setup({
      limiter: refusing,
      storage: context.storage,
      sessions: context.sessions,
      itineraries: context.itineraries,
    });

    expect((await limited.chat(sessionId, "こんにちは")).status).toBe(429);
  });

  it("live で混み合っていたら 503 で断り、緊急の連絡先は返す", async () => {
    const live: GuideRunner = {
      mode: "live",
      today: () => "2026-08-03",
      now: () => "2026-08-03T10:00:00+09:00",
      runTurn: async () => {},
    };
    const concurrency = new ConcurrencyLimiter(1);
    concurrency.tryAcquire("someone");
    const context = setup({ guide: { runner: live }, concurrency });
    const { sessionId } = await context.consult();

    expect((await context.chat(sessionId, "こんにちは")).status).toBe(503);
    const res = await context.chat(sessionId, EMERGENCY_MESSAGE);
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(events.map((event) => event.type)).toEqual([
      "guide.emergency",
      "message.delta",
      "error",
      "guide.done",
    ]);
    expect(JSON.stringify(events[2])).toContain("もう一度");
  });
});

describe("ガイドの手帳", () => {
  it("項目を見て、直して、消せる", async () => {
    const context = setup();
    const { sessionId } = await context.consult();
    const item = await saveMemo(context, sessionId);

    expect((await context.state(sessionId)).memo).toEqual([item]);

    const updated = await context.call(`/api/guide/memo/${item.id}`, {
      body: { sessionId, text: "連れはゆっくり歩く" },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: item.id, text: "連れはゆっくり歩く" });
    expect((await context.state(sessionId)).memo[0]?.text).toBe("連れはゆっくり歩く");

    const deleted = await context.call(`/api/guide/memo/${item.id}/delete`, {
      body: { sessionId },
    });
    expect(deleted.status).toBe(204);
    expect((await context.state(sessionId)).memo).toEqual([]);
    expect(
      (await context.call(`/api/guide/memo/${item.id}/delete`, { body: { sessionId } })).status,
    ).toBe(404);
  });

  it.each([
    ["現在地", "現在地は鈴鳴駅です"],
    ["連絡先", "090-1234-5678"],
    ["メール", "someone@example.com"],
    ["体調", "持病があります"],
    ["秘密の値", "パスワードは秘密"],
  ])("%sに直そうとしても、手帳に残らない", async (_name, text) => {
    const context = setup();
    const { sessionId } = await context.consult();
    const item = await saveMemo(context, sessionId);

    const res = await context.call(`/api/guide/memo/${item.id}`, { body: { sessionId, text } });

    expect(res.status).toBe(400);
    expect((await context.state(sessionId)).memo[0]?.text).toBe(item.text);
  });

  it("ない項目は 404、長すぎる文は 400", async () => {
    const context = setup();
    const { sessionId } = await context.consult();
    const item = await saveMemo(context, sessionId);

    expect(
      (await context.call("/api/guide/memo/memo-none", { body: { sessionId, text: "ゆっくり" } }))
        .status,
    ).toBe(404);
    expect(
      (
        await context.call(`/api/guide/memo/${item.id}`, {
          body: { sessionId, text: "あ".repeat(81) },
        })
      ).status,
    ).toBe(400);
  });

  it("ほかの人の手帳は、読めず、直せず、消せない", async () => {
    const context = setup();
    const { sessionId } = await context.consult(ALICE);
    const item = await saveMemo(context, sessionId, ALICE);

    for (const user of [BOB, undefined]) {
      const init = user === undefined ? {} : { user };
      expect(
        (await context.call("/api/guide/state", { body: { sessionId }, ...init })).status,
      ).toBe(404);
      expect(
        (
          await context.call(`/api/guide/memo/${item.id}`, {
            body: { sessionId, text: "書き換え" },
            ...init,
          })
        ).status,
      ).toBe(404);
      expect(
        (await context.call(`/api/guide/memo/${item.id}/delete`, { body: { sessionId }, ...init }))
          .status,
      ).toBe(404);
    }
    expect((await context.state(sessionId, ALICE)).memo[0]?.text).toBe(item.text);
  });

  it("別の旅の手帳は読めない", async () => {
    const context = setup();
    const first = await context.consult(ALICE);
    const second = await context.consult(ALICE);
    const item = await saveMemo(context, first.sessionId, ALICE);

    expect((await context.state(second.sessionId, ALICE)).memo).toEqual([]);
    const res = await context.call(`/api/guide/memo/${item.id}/delete`, {
      user: ALICE,
      body: { sessionId: second.sessionId },
    });
    expect(res.status).toBe(404);
  });
});

describe("残した旅", () => {
  /** A が旅を残し、ガイドの相談を開く */
  const keptTrip = async (context: ReturnType<typeof setup>) => {
    const { sessionId, itineraryId } = await context.consult(ALICE);
    await context.call("/api/trips", { user: ALICE, body: { sessionId } });
    const opened = await context.call("/api/guide/open", {
      user: ALICE,
      body: { tripId: itineraryId },
    });
    expect(opened.status).toBe(201);
    const { sessionId: guideSession } = SessionResponseSchema.parse(await opened.json());
    return { itineraryId, guideSession };
  };

  it("自分の旅だけを開き、旅の条件を相談に戻す", async () => {
    const context = setup();
    const { itineraryId, guideSession } = await keptTrip(context);
    const itinerary = context.itineraries.get(itineraryId);

    const session = context.sessions.get(guideSession);
    expect(session?.itineraryId).toBe(itineraryId);
    expect(session?.ownerUid).toBe(ALICE);
    expect(session?.stage).toBe("shiori");
    expect(session?.preferences).toEqual(itinerary?.preferences);
    expect(session?.conditions.origin).toBe(itinerary?.origin);

    const open = (user?: string, tripId = itineraryId) =>
      context.call("/api/guide/open", { body: { tripId }, ...(user ? { user } : {}) });
    expect((await open(BOB)).status).toBe(404);
    expect((await open()).status).toBe(401);
    expect((await open(ALICE, "trip-none")).status).toBe(404);
    expect(
      (
        await context.call("/api/guide/open", {
          user: ALICE,
          body: { tripId: itineraryId, ownerUid: BOB },
        })
      ).status,
    ).toBe(400);
  });

  it("手帳と通知は旅の下に残り、別の相談や別のインスタンスからも読める", async () => {
    const storage = new MemoryTripStorage();
    const first = setup({ storage });
    const { itineraryId, guideSession } = await keptTrip(first);
    const item = await saveMemo(first, guideSession, ALICE);

    expect(first.sessions.get(guideSession)?.guide.memo).toEqual([]);
    expect(
      await storage.forOwner(ownerIdOf(ALICE)).tripDocs(itineraryId).get("memo", item.id),
    ).toEqual(item);

    // 別のインスタンスが新しく開いた相談からも読める
    const second = setup({ storage });
    const opened = await second.call("/api/guide/open", {
      user: ALICE,
      body: { tripId: itineraryId },
    });
    const { sessionId } = SessionResponseSchema.parse(await opened.json());
    expect((await second.state(sessionId, ALICE)).memo).toEqual([item]);

    // 同じ相談が別のインスタンスに届いても、持ち主だけが続けられる
    expect((await second.state(guideSession, ALICE)).memo).toEqual([item]);
    expect(
      (await second.call("/api/guide/state", { body: { sessionId: guideSession } })).status,
    ).toBe(404);
  });

  it("旅を消すと、手帳も通知も提案も消え、ガイドは開けない", async () => {
    const context = setup();
    const { itineraryId, guideSession } = await keptTrip(context);
    await saveMemo(context, guideSession, ALICE);
    const docs = context.storage.forOwner(ownerIdOf(ALICE)).tripDocs(itineraryId);
    expect(await docs.list("memo")).toHaveLength(1);
    expect(await docs.list("notices")).toHaveLength(1);
    expect(await docs.list("proposals")).toHaveLength(1);

    const deleted = await context.call(`/api/trips/${itineraryId}`, {
      method: "DELETE",
      user: ALICE,
    });

    expect(deleted.status).toBe(204);
    for (const kind of ["memo", "notices", "proposals", "watch"] as const) {
      expect(await docs.list(kind), kind).toEqual([]);
    }
    expect(
      (await context.call("/api/guide/state", { user: ALICE, body: { sessionId: guideSession } }))
        .status,
    ).toBe(404);
    expect(
      (await context.call("/api/guide/open", { user: ALICE, body: { tripId: itineraryId } }))
        .status,
    ).toBe(404);
    expect((await context.chat(guideSession, "こんにちは", ALICE)).status).toBe(404);
  });

  it("残す前の旅を消すと、相談の中の手帳も消える", async () => {
    const context = setup();
    const { sessionId, itineraryId } = await context.consult(ALICE);
    await saveMemo(context, sessionId, ALICE);
    expect(context.sessions.get(sessionId)?.guide.memo).toHaveLength(1);

    await context.call(`/api/trips/${itineraryId}`, { method: "DELETE", user: ALICE });

    expect(
      (await context.call("/api/guide/state", { user: ALICE, body: { sessionId } })).status,
    ).toBe(404);
    expect(context.sessions.get(sessionId)?.guide.memo).toEqual([]);
    expect(JSON.stringify(await context.storage.getSession(sessionId))).not.toContain(
      "連れは歩くのがゆっくり",
    );
  });

  it("旅の読み取りが一時的に失敗したら、もう一度を求め、相談の中の手帳を消さない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = new TroubledStorage();
    const context = setup({ storage });
    const { sessionId } = await context.consult();
    const item = await saveMemo(context, sessionId);
    const session = context.sessions.get(sessionId);
    if (session === undefined) throw new Error("相談がありません");
    // 手元の写しもない旅にする
    session.itineraryId = "trip-not-at-hand";
    storage.failing = true;

    const res = await context.call("/api/guide/state", { body: { sessionId } });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ retryable: true });
    expect(session.guide.memo).toEqual([item]);
  });

  it("読めない形の旅程でも、相談の中の手帳を消さない", async () => {
    const storage = new TroubledStorage();
    const context = setup({ storage });
    const { sessionId } = await context.consult();
    const item = await saveMemo(context, sessionId);
    storage.broken = true;

    const res = await context.call("/api/guide/state", { body: { sessionId } });

    expect(res.status).toBe(404);
    expect(context.sessions.get(sessionId)?.guide.memo).toEqual([item]);
  });

  it("緊急の発言は、返事のあとに保存の口が止まっても閉じる", async () => {
    const storage = new TroubledStorage();
    const context = setup({
      storage,
      emergencyWaitMs: 5,
      guide: {
        runner: {
          mode: "live",
          today: () => "2026-08-03",
          now: () => "2026-08-03T10:00:00+09:00",
          runTurn: async (_input, emit) => {
            emit({ type: "message.delta", data: { messageId: "m-1", text: "電話してください" } });
          },
        },
      },
    });
    const { guideSession } = await keptTrip(context);
    storage.stalled.add("docs.list");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const events = await readEvents(await context.chat(guideSession, EMERGENCY_MESSAGE, ALICE));

    expect(events.map((event) => event.type)).toEqual([
      "guide.emergency",
      "message.delta",
      "guide.done",
    ]);
    expect(events.at(-1)).toMatchObject({ data: { unreadNotices: 0, pendingProposals: 0 } });
    expect(context.sessions.get(guideSession)?.busy).toBe(false);
  });

  it("保存の口の版が手元より古くても、手元の旅程を古い版へ戻さない", async () => {
    const storage = new MemoryTripStorage();
    const context = setup({ storage });
    const { sessionId, itineraryId } = await context.consult(ALICE);
    const current = context.itineraries.get(itineraryId);
    if (current === undefined) throw new Error("旅程がありません");
    context.itineraries.remember({ ...current, version: current.version + 5 });

    const state = await context.state(sessionId, ALICE);

    expect(state.version).toBe(current.version + 5);
    expect(context.itineraries.get(itineraryId)?.version).toBe(current.version + 5);
  });

  it("ログインせずに残した手帳は、ログインして旅を残すと、旅の下へ移る", async () => {
    const context = setup();
    const { sessionId, itineraryId } = await context.consult();
    const item = await saveMemo(context, sessionId);
    expect(context.sessions.get(sessionId)?.guide.memo).toHaveLength(1);

    await context.call("/api/trips", { user: ALICE, body: { sessionId } });
    const state = await context.state(sessionId, ALICE);

    expect(state.memo).toEqual([item]);
    expect(context.sessions.get(sessionId)?.guide.memo).toEqual([]);
    expect(
      await context.storage.forOwner(ownerIdOf(ALICE)).tripDocs(itineraryId).get("memo", item.id),
    ).toEqual(item);
  });
});

describe("ログインしていない相談", () => {
  it("手帳と続きの要約は相談の中に持ち、別のインスタンスでも続けられる", async () => {
    const storage = new MemoryTripStorage();
    const first = setup({ storage });
    const { sessionId } = await first.consult();
    const item = await saveMemo(first, sessionId);

    const second = setup({ storage });
    const state = await second.state(sessionId);

    expect(state.memo).toEqual([item]);
    const session = second.sessions.get(sessionId);
    expect(session?.guide.resume.turns).toBe(1);
    expect(session?.guide.agentSessionId).toBeNull();
    // 保存の口に、会話の文を残さない
    const saved = JSON.stringify(await storage.getSession(sessionId));
    expect(saved).not.toContain(MEMO_MESSAGE);
    expect(saved).not.toContain("手帳はいつでも見て");
  });
});

describe("通知・見回り・提案の決定", () => {
  /** A が旅を残し、ガイドの相談を開いて、記録の通知と提案を受け取る */
  const keptGuide = async (context: ReturnType<typeof setup>) => {
    const { sessionId, itineraryId } = await context.consult(ALICE);
    await context.call("/api/trips", { user: ALICE, body: { sessionId } });
    const opened = await context.call("/api/guide/open", {
      user: ALICE,
      body: { tripId: itineraryId },
    });
    const { sessionId: guideSession } = SessionResponseSchema.parse(await opened.json());
    const state = await context.state(guideSession, ALICE);
    const [proposal] = state.proposals;
    if (proposal === undefined) throw new Error("提案がありません");
    return { itineraryId, guideSession, state, proposal };
  };

  const decide = (
    context: ReturnType<typeof setup>,
    sessionId: string,
    proposal: { id: string; baseVersion: number; contentHash: string },
    user?: string,
  ) =>
    context.call(`/api/guide/proposals/${proposal.id}/decision`, {
      body: {
        decision: "approve",
        sessionId,
        baseVersion: proposal.baseVersion,
        contentHash: proposal.contentHash,
      },
      ...(user ? { user } : {}),
    });

  it("通知を読んだことにし、未読の数を返す。この旅にない通知だけなら 404", async () => {
    const context = setup();
    const { guideSession, state } = await keptGuide(context);
    const [notice] = state.notices;
    if (notice === undefined) throw new Error("通知がありません");

    const read = await context.call("/api/guide/notices/read", {
      user: ALICE,
      body: { sessionId: guideSession, noticeIds: [notice.id] },
    });

    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ unread: 0 });
    expect((await context.state(guideSession, ALICE)).notices[0]?.readAt).not.toBeNull();
    const missing = await context.call("/api/guide/notices/read", {
      user: ALICE,
      body: { sessionId: guideSession, noticeIds: ["notice-of-someone-else"] },
    });
    expect(missing.status).toBe(404);
  });

  it("承認すると版が1つ増え、差分を返す。同じ承認が2回届いても、版は1つしか増えない", async () => {
    const context = setup();
    const { itineraryId, guideSession, state, proposal } = await keptGuide(context);

    const [first, second] = await Promise.all([
      decide(context, guideSession, proposal, ALICE),
      decide(context, guideSession, proposal, ALICE),
    ]);
    const firstBody = await first.json();

    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({
      outcome: "applied",
      change: { itinerary: { version: state.version + 1 }, diff: proposal.diff },
    });
    expect(await second.json()).toEqual(firstBody);
    expect(await (await decide(context, guideSession, proposal, ALICE)).json()).toEqual(firstBody);
    const after = await context.state(guideSession, ALICE);
    expect(after.version).toBe(state.version + 1);
    expect(after.proposals).toEqual([]);
    const detail = await context.storage.forOwner(ownerIdOf(ALICE)).getTrip(itineraryId);
    expect(detail?.version).toBe(state.version + 1);
  });

  it("断ると旅程は変わらず、承認待ちから外れる", async () => {
    const context = setup();
    const { guideSession, state, proposal } = await keptGuide(context);

    const res = await context.call(`/api/guide/proposals/${proposal.id}/decision`, {
      user: ALICE,
      body: { decision: "reject", sessionId: guideSession },
    });

    expect(await res.json()).toEqual({ outcome: "rejected" });
    const after = await context.state(guideSession, ALICE);
    expect(after.version).toBe(state.version);
    expect(after.proposals).toEqual([]);
    expect(await (await decide(context, guideSession, proposal, ALICE)).json()).toEqual({
      outcome: "rejected",
    });
  });

  it("提案のあとに旅程が変わると、古い提案は承認できない", async () => {
    const context = setup();
    const { itineraryId, guideSession, state, proposal } = await keptGuide(context);
    const current = context.itineraries.get(itineraryId);
    if (current === undefined) throw new Error("旅程がありません");
    context.itineraries.save({ ...current, version: current.version + 1 }, ownerIdOf(ALICE));

    const res = await decide(context, guideSession, proposal, ALICE);

    expect(await res.json()).toEqual({ outcome: "stale", currentVersion: state.version + 1 });
    expect((await context.state(guideSession, ALICE)).version).toBe(state.version + 1);
  });

  it("見た提案と版かハッシュが違えば、承認できない", async () => {
    const context = setup();
    const { guideSession, state, proposal } = await keptGuide(context);

    const res = await decide(
      context,
      guideSession,
      { ...proposal, contentHash: "f".repeat(64) },
      ALICE,
    );

    expect(await res.json()).toEqual({ outcome: "stale", currentVersion: state.version });
    expect((await context.state(guideSession, ALICE)).proposals).toHaveLength(1);
  });

  it("期限を過ぎた提案は承認できない", async () => {
    let now = "2026-08-10T12:00:00+09:00";
    class Clocked extends ReplayGuideRunner {
      override now() {
        return now;
      }
    }
    const context = setup({ guide: { runner: new Clocked(guides, { speed: 0 }) } });
    const { guideSession, state, proposal } = await keptGuide(context);
    now = proposal.expiresAt;

    const res = await decide(context, guideSession, proposal, ALICE);

    expect(await res.json()).toEqual({ outcome: "expired" });
    expect((await context.state(guideSession, ALICE)).version).toBe(state.version);
  });

  it("ほかの人の提案は 404 で、承認できない", async () => {
    const context = setup();
    const { guideSession, state, proposal } = await keptGuide(context);
    const other = await context.consult(BOB);

    expect((await decide(context, guideSession, proposal, BOB)).status).toBe(404);
    const unknown = { ...proposal, id: "proposal-none" };
    expect((await decide(context, other.sessionId, unknown, BOB)).status).toBe(404);
    expect((await context.state(guideSession, ALICE)).version).toBe(state.version);
  });

  it("承認した変更を前の版に戻せる。戻す操作も新しい版になり、履歴は消えない", async () => {
    const context = setup();
    const { itineraryId, guideSession, state, proposal } = await keptGuide(context);
    await decide(context, guideSession, proposal, ALICE);

    const res = await context.call("/api/guide/revert", {
      user: ALICE,
      body: { sessionId: guideSession, toVersion: state.version },
    });

    expect(res.status).toBe(200);
    const change = (await res.json()) as {
      itinerary: { version: number };
      diff: { fromVersion: number; toVersion: number; changed: string[] };
    };
    expect(change.itinerary.version).toBe(state.version + 2);
    expect(change.diff).toMatchObject({
      fromVersion: state.version + 1,
      toVersion: state.version + 2,
      changed: proposal.diff.changed,
    });
    const detail = await context.storage.forOwner(ownerIdOf(ALICE)).getTrip(itineraryId);
    expect(detail?.versions).toEqual(
      expect.arrayContaining([state.version, state.version + 1, state.version + 2]),
    );
    // いまの版や、いまと同じ旅程へは戻さない
    for (const toVersion of [state.version + 2, state.version]) {
      const again = await context.call("/api/guide/revert", {
        user: ALICE,
        body: { sessionId: guideSession, toVersion },
      });
      expect(again.status, String(toVersion)).toBe(409);
    }
    const other = await context.call("/api/guide/revert", {
      user: BOB,
      body: { sessionId: guideSession, toVersion: state.version },
    });
    expect(other.status).toBe(404);
  });

  it("見回りを止めて、また始められる。ほかの人は止められない", async () => {
    const context = setup();
    const { itineraryId, guideSession } = await keptGuide(context);
    const watch = (user: string, action: "start" | "stop") =>
      context.call("/api/guide/watch", { user, body: { sessionId: guideSession, action } });

    expect((await watch(BOB, "stop")).status).toBe(404);
    const stopped = await watch(ALICE, "stop");
    expect(await stopped.json()).toMatchObject({ tripId: itineraryId, status: "stopped" });
    const docs = context.storage.forOwner(ownerIdOf(ALICE)).tripDocs(itineraryId);
    expect(await docs.get("watch", "current")).toMatchObject({ status: "stopped" });

    const started = await watch(ALICE, "start");
    expect(await started.json()).toMatchObject({ status: "active", stoppedAt: null });
    expect((await context.state(guideSession, ALICE)).watch?.status).toBe("active");
  });

  it("残す前の旅で見回りを始めると、旅を残してから旅の下に書く。ログインなしは 401", async () => {
    const context = setup();
    const { sessionId, itineraryId } = await context.consult(ALICE);
    const anonymous = await context.consult();

    const guest = await context.call("/api/guide/watch", {
      body: { sessionId: anonymous.sessionId, action: "start" },
    });
    expect(guest.status).toBe(401);

    const res = await context.call("/api/guide/watch", {
      user: ALICE,
      body: { sessionId, action: "start" },
    });

    expect(res.status).toBe(200);
    const listed = await context.call("/api/trips", { method: "GET", user: ALICE });
    const { trips } = (await listed.json()) as { trips: { itineraryId: string }[] };
    expect(trips.map((trip) => trip.itineraryId)).toEqual([itineraryId]);
    const docs = context.storage.forOwner(ownerIdOf(ALICE)).tripDocs(itineraryId);
    expect(await docs.get("watch", "current")).toMatchObject({ status: "active" });
    expect(context.sessions.get(sessionId)?.guide.watch).toBeNull();
  });

  it("モックで、見回りの通知を読み、承認して、前の版に戻せる（ログインを用意していない環境）", async () => {
    const context = setup({ authConfig: { enabled: false } });
    const { sessionId } = await context.consult();
    const state = await context.state(sessionId);
    const [notice] = state.notices;
    const [proposal] = state.proposals;
    if (notice === undefined || proposal === undefined) throw new Error("記録が届いていません");
    expect(notice.proposalId).toBe(proposal.id);

    const read = await context.call("/api/guide/notices/read", {
      body: { sessionId, noticeIds: [notice.id] },
    });
    expect(await read.json()).toEqual({ unread: 0 });
    const applied = await decide(context, sessionId, proposal);
    expect(await applied.json()).toMatchObject({ outcome: "applied" });
    expect((await context.state(sessionId)).version).toBe(state.version + 1);

    const reverted = await context.call("/api/guide/revert", {
      body: { sessionId, toVersion: state.version },
    });
    expect(reverted.status).toBe(200);
    expect((await context.state(sessionId)).version).toBe(state.version + 2);

    const stopped = await context.call("/api/guide/watch", {
      body: { sessionId, action: "stop" },
    });
    expect(await stopped.json()).toMatchObject({ status: "stopped" });
  });
});
