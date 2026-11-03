import { fileURLToPath } from "node:url";
import {
  DEFAULT_PREFERENCES,
  decodeSseEvent,
  FestivalSchema,
  FestivalsResponseSchema,
  type SampleConversation,
  SessionResponseSchema,
  type SseEvent,
} from "@matsuri-ikoka/schema";
import { fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSampleConversations, ReplayAgentRunner } from "./agent/replayRunner";
import { AgentError, type AgentRunner } from "./agent/runner";
import { type AppDeps, createApp } from "./app";
import { createFestivalStore, type FestivalStore, loadFestivals } from "./data/festivalStore";
import { testFestival } from "./domain/testFestivals";
import { ConcurrencyLimiter, DailyLimiter } from "./routes/guard";
import { ItineraryStore, SessionStore } from "./session/sessionStore";

const root = (relative: string) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

let samples: SampleConversation[];
let festivals: FestivalStore;

beforeAll(async () => {
  samples = await loadSampleConversations(root("data/samples/conversations"));
  festivals = (await loadFestivals([root("data/samples/festivals")])).store;
});

function setup(overrides: Partial<AppDeps> = {}) {
  const itineraries = overrides.itineraries ?? new ItineraryStore();
  const sessions = overrides.sessions ?? new SessionStore();
  const deps: AppDeps = {
    runner: new ReplayAgentRunner(samples, itineraries, { speed: 0 }),
    sessions,
    itineraries,
    festivals,
    limiter: new DailyLimiter(null, () => "2026-08-03"),
    accessPasscode: null,
    ...overrides,
  };
  const app = createApp(deps);
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    method = "POST",
  ) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const newSession = async () =>
    ((await (await post("/api/session", {})).json()) as { sessionId: string }).sessionId;
  return { app, deps, post, newSession, itineraries, sessions };
}

/** SSE の本文を、イベントとコメント行に分ける */
async function readSse(res: Response) {
  const text = await res.text();
  const events: SseEvent[] = [];
  let comments = 0;
  for (const block of text.split(/\n\n/)) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    if (lines.every((line) => line.startsWith(":"))) {
      comments += 1;
      continue;
    }
    const event = lines
      .find((l) => l.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (event) events.push(decodeSseEvent({ event, data }));
  }
  return { events, comments };
}

const chat = (sessionId: string, message = "こんにちは") => ({
  sessionId,
  message,
  preferences: DEFAULT_PREFERENCES,
});

describe("GET /healthz・/health", () => {
  it.each(["/healthz", "/health"])("死活監視に ok を返す（%s）", async (path) => {
    const res = await setup().app.request(path);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /api/chat（mock）", () => {
  /** 旅程 ID は相談ごとに置き換わるので、比べるときはそろえる */
  const withoutItineraryId = (event: SseEvent): SseEvent =>
    event.type === "itinerary.updated"
      ? { ...event, data: { ...event.data, itinerary: { ...event.data.itinerary, id: "trip" } } }
      : event;
  const itineraryIds = (events: SseEvent[]) =>
    events.flatMap((e) => (e.type === "itinerary.updated" ? [e.data.itinerary.id] : []));

  it("サンプルの相談を SSE で最後まで流し、最後に必ず done を送る", async () => {
    const { post, newSession } = setup();
    const sessionId = await newSession();

    for (const turn of samples[0]!.turns) {
      const res = await post("/api/chat", chat(sessionId));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const { events } = await readSse(res);

      expect(events.map(withoutItineraryId)).toEqual(
        turn.events.map((e) => withoutItineraryId(e.event)),
      );
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    }
  });

  it("記録の旅程 ID は相談ごとに置き換え、同じ相談の中では同じにする", async () => {
    const { post, newSession } = setup();
    const play = async () => {
      const sessionId = await newSession();
      const ids: string[] = [];
      for (const _ of samples[0]!.turns) {
        ids.push(...itineraryIds((await readSse(await post("/api/chat", chat(sessionId)))).events));
      }
      return ids;
    };

    const first = await play();
    const second = await play();
    const recorded = itineraryIds(samples[0]!.turns.flatMap((t) => t.events.map((e) => e.event)));

    expect(first.length).toBeGreaterThan(1);
    expect(new Set(first).size).toBe(1);
    expect(first[0]).not.toBe(second[0]);
    expect(first).not.toContain(recorded[0]);
  });

  it("形の違う発言は 400、ない相談は 404 で断る", async () => {
    const { post, newSession } = setup();
    const sessionId = await newSession();

    const empty = await post("/api/chat", chat(sessionId, "   "));
    const broken = await post("/api/chat", "{");
    const missing = await post("/api/chat", chat("no-such-session"));

    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ code: "bad_request", retryable: false });
    expect(broken.status).toBe(400);
    expect(missing.status).toBe(404);
  });

  it("1日の回数の上限を超えたら 429", async () => {
    const { post, newSession } = setup({ limiter: new DailyLimiter(1, () => "2026-08-03") });
    const sessionId = await newSession();

    await (await post("/api/chat", chat(sessionId))).text();
    const second = await post("/api/chat", chat(sessionId));

    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "rate_limited" });
  });

  it("IP ごとの1日の上限を超えたら、その IP だけ 429", async () => {
    const { post, newSession } = setup({
      ipLimiter: new DailyLimiter(1, () => "2026-08-03"),
      clientIp: (c) => c.req.header("x-test-ip") ?? "unknown",
    });
    const sessionId = await newSession();

    await (await post("/api/chat", chat(sessionId), { "x-test-ip": "203.0.113.1" })).text();
    const same = await post("/api/chat", chat(sessionId), { "x-test-ip": "203.0.113.1" });
    const other = await post("/api/chat", chat(sessionId), { "x-test-ip": "203.0.113.2" });

    expect(same.status).toBe(429);
    expect(other.status).toBe(200);
    await other.text();
  });

  it("live で同時に返事を作る数を超えたら 503。返事が終われば枠を返す", async () => {
    let finish = () => {};
    const runner: AgentRunner = {
      mode: "live",
      runTurn: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    };
    const sessions = new SessionStore();
    const first = sessions.create();
    const second = sessions.create();
    const concurrency = new ConcurrencyLimiter(1);
    const { post } = setup({ runner, sessions, concurrency });

    const running = post("/api/chat", chat(first.id));
    const busy = await post("/api/chat", chat(second.id));
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ code: "upstream_unavailable", retryable: true });

    const res = await running;
    finish();
    await res.text();
    expect(concurrency.running).toBe(0);
  });

  it("返事を作っている途中の相談には 409", async () => {
    const { post, newSession, sessions } = setup();
    const sessionId = await newSession();
    sessions.get(sessionId)!.busy = true;

    expect((await post("/api/chat", chat(sessionId))).status).toBe(409);
  });
});

describe("合言葉", () => {
  it("設定されていれば、ヘッダーの合言葉が合うときだけ通す。しおりと死活監視は通す", async () => {
    const { app, post } = setup({ accessPasscode: "fictional-passcode" });

    const without = await post("/api/session", {});
    const wrong = await post("/api/session", {}, { "x-access-passcode": "wrong" });
    const right = await post("/api/session", {}, { "x-access-passcode": "fictional-passcode" });

    expect(without.status).toBe(401);
    expect(await without.json()).toMatchObject({ code: "unauthorized" });
    expect(wrong.status).toBe(401);
    expect(right.status).toBe(201);
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/shiori/no-such")).status).toBe(404);
  });
});

describe("時間の上限と失敗", () => {
  const sessionWith = (runner: AgentRunner, extra: Partial<AppDeps> = {}) => {
    const sessions = new SessionStore();
    const session = sessions.create();
    return { ...setup({ runner, sessions, ...extra }), session };
  };

  it("進みのない時間が上限を超えたら、途中までの結果のあとに timeout と done を送る", async () => {
    const slow: AgentRunner = {
      mode: "live",
      async runTurn({ signal }, emit) {
        emit({ type: "message.delta", data: { messageId: "m-1", text: "少々お待ちください。" } });
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
    };
    const { post, session } = sessionWith(slow, { turnIdleMs: 30 });

    const { events } = await readSse(await post("/api/chat", chat(session.id)));

    expect(events.map((e) => e.type)).toEqual(["message.delta", "error", "done"]);
    expect(events[1]).toMatchObject({ data: { code: "timeout", retryable: true } });
    expect(session.busy).toBe(false);
  });

  it("進みがあるうちは止めず、全体の上限を超えたら止める", async () => {
    let ticks = 0;
    const busy: AgentRunner = {
      mode: "live",
      async runTurn({ signal, progress }) {
        // 進みのない時間の上限（40ミリ秒）より長く動くが、10ミリ秒ごとに進みを知らせる
        while (!signal.aborted && ticks < 12) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          ticks += 1;
          progress?.();
        }
        if (signal.aborted) throw signal.reason;
      },
    };
    const kept = sessionWith(busy, { turnIdleMs: 40 });
    const first = await readSse(await kept.post("/api/chat", chat(kept.session.id)));
    expect(first.events.map((e) => e.type)).toEqual(["done"]);
    expect(ticks).toBe(12);

    ticks = -1000;
    const capped = sessionWith(busy, { turnIdleMs: 40, turnMaxMs: 60 });
    const second = await readSse(await capped.post("/api/chat", chat(capped.session.id)));
    expect(second.events.map((e) => e.type)).toEqual(["error", "done"]);
    expect(second.events[0]).toMatchObject({ data: { code: "timeout" } });
  });

  it("15秒ごとの空のコメント行で、接続を保つ", async () => {
    const waiting: AgentRunner = {
      mode: "live",
      runTurn: () => new Promise((resolve) => setTimeout(resolve, 60)),
    };
    const { post, session } = sessionWith(waiting, { heartbeatMs: 10 });

    const { events, comments } = await readSse(await post("/api/chat", chat(session.id)));

    expect(comments).toBeGreaterThan(0);
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  it("エージェントの失敗は、利用者に見せる一文の error にする", async () => {
    const failing: AgentRunner = {
      mode: "live",
      async runTurn() {
        throw new AgentError("upstream_unavailable", "いま混み合っています。", true);
      },
    };
    const { post, session } = sessionWith(failing);

    const { events } = await readSse(await post("/api/chat", chat(session.id)));

    expect(events).toEqual([
      {
        type: "error",
        data: { code: "upstream_unavailable", message: "いま混み合っています。", retryable: true },
      },
      {
        type: "done",
        data: { stage: "hearing", conditions: {}, preferences: DEFAULT_PREFERENCES },
      },
    ]);
  });

  it("形の違うイベントは送らない", async () => {
    const broken: AgentRunner = {
      mode: "live",
      async runTurn(_input, emit) {
        emit({ type: "message.delta", data: { messageId: "m-1", text: "" } });
      },
    };
    const { post, session } = sessionWith(broken);

    const { events } = await readSse(await post("/api/chat", chat(session.id)));

    expect(events.map((e) => e.type)).toEqual(["done"]);
  });
});

describe("PATCH /api/preferences", () => {
  it("旅程がなければ、こだわりを変えて done だけを返す", async () => {
    const { post, newSession } = setup();
    const sessionId = await newSession();
    const preferences = { party: "kids", spot: "hidden", food: "local", move: "car" } as const;

    const res = await post("/api/preferences", { sessionId, preferences }, {}, "PATCH");
    const { events } = await readSse(res);

    expect(events).toEqual([
      { type: "done", data: { stage: "hearing", conditions: {}, preferences } },
    ]);
  });

  it("live で旅程があれば、旅程係に組み直しを頼む発言として動かす", async () => {
    const messages: string[] = [];
    const runner: AgentRunner = {
      mode: "live",
      async runTurn({ message }) {
        messages.push(message);
      },
    };
    const sessions = new SessionStore();
    const session = sessions.create();
    session.itineraryId = "trip-x";
    const { post } = setup({ runner, sessions });

    await (
      await post(
        "/api/preferences",
        { sessionId: session.id, preferences: { ...DEFAULT_PREFERENCES, party: "kids" } },
        {},
        "PATCH",
      )
    ).text();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("子連れ");
    expect(messages[0]).toContain("旅程係にだけ頼んで");
  });
});

describe("POST /api/session", () => {
  it("本文なしで相談を始め、セッション ID を返す", async () => {
    const { app } = setup();

    const res = await app.request("/api/session", { method: "POST" });

    expect(res.status).toBe(201);
    expect(SessionResponseSchema.safeParse(await res.json()).success).toBe(true);
  });
});

describe("GET /api/festivals", () => {
  it("祭りのデータの一覧を返し、掲載停止の祭りは含めない", async () => {
    const { app } = setup({
      festivals: createFestivalStore([
        testFestival({ id: "suzunari-toro" }),
        testFestival({ id: "opted-out", optOut: true }),
      ]),
    });

    const res = await app.request("/api/festivals");

    expect(res.status).toBe(200);
    const body = FestivalsResponseSchema.parse(await res.json());
    expect(body.festivals.map((f) => f.id)).toEqual(["suzunari-toro"]);
  });
});

describe("GET /api/festivals/:id", () => {
  it("祭りのデータを FestivalSchema の形で返す", async () => {
    const res = await setup().app.request("/api/festivals/suzunari-toro");

    expect(res.status).toBe(200);
    const festival = FestivalSchema.parse(await res.json());
    expect(festival.id).toBe("suzunari-toro");
    expect(festival.etiquette.participation).toBe("join_by_application");
  });

  it("ない祭り・ID の形が違う祭り・掲載停止の祭りは 404", async () => {
    const { app } = setup({
      festivals: createFestivalStore([testFestival({ id: "opted-out", optOut: true })]),
    });

    for (const id of ["no-such", "Not%20A%20Slug", "opted-out"]) {
      const res = await app.request(`/api/festivals/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "bad_request" });
    }
  });
});

describe("旅程としおり", () => {
  it("サンプルの相談を最後まで流すと、旅程を JSON で、確定した旅程をしおりで引ける", async () => {
    const { app, post, newSession, sessions } = setup();
    const sessionId = await newSession();

    await (await post("/api/chat", chat(sessionId))).text();
    await (await post("/api/chat", chat(sessionId))).text();
    const itineraryId = sessions.get(sessionId)!.itineraryId!;
    const json = await app.request(`/api/itinerary/${itineraryId}`);
    const notYet = await app.request(`/shiori/${itineraryId}`);
    for (const _ of samples[0]!.turns.slice(2))
      await (await post("/api/chat", chat(sessionId))).text();
    const shiori = await app.request(`/shiori/${itineraryId}`);
    const page = await shiori.text();

    expect(json.status).toBe(200);
    expect(((await json.json()) as { id: string }).id).toBe(itineraryId);
    expect(notYet.status).toBe(409);
    expect(shiori.status).toBe(200);
    expect(shiori.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page).toContain("鈴鳴灯籠まつりの見どころ");
    expect(page).toContain("はじめての方へ");
    expect(page).toContain("公式情報で開催予定を確認済み");
    expect(page).toContain("https://example.com/suzunari/2026");
    expect((await app.request("/api/itinerary/no-such")).status).toBe(404);
  });

  it("公式の出典のない「予定どおり」の旅程は、しおりにしない", async () => {
    const { app, itineraries } = setup();
    const itinerary = fictionalItinerary();
    itinerary.verification = {
      status: "as_planned",
      checkedAt: "2026-08-03T10:00:00+09:00",
      sources: [{ url: "https://example.net/blog", checkedAt: "2026-08-03", confidence: "single" }],
    };
    itineraries.save(itinerary);

    expect((await app.request(`/shiori/${itinerary.id}`)).status).toBe(409);
  });

  it("しおりは文字列をエスケープして埋め込む", async () => {
    const { app, itineraries } = setup({ festivals: createFestivalStore([]) });
    const itinerary = fictionalItinerary();
    itinerary.title = "<script>alert(1)</script>";
    itinerary.verification = {
      status: "as_planned",
      checkedAt: "2026-08-03T10:00:00+09:00",
      sources: [
        {
          url: "https://example.com/suzunari/2026",
          checkedAt: "2026-08-03",
          confidence: "official",
        },
      ],
    };
    itineraries.save(itinerary);

    const page = await (await app.request(`/shiori/${itinerary.id}`)).text();

    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
  });
});
