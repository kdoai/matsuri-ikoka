import { fileURLToPath } from "node:url";
import {
  AnchorPlanSchema,
  DEFAULT_PREFERENCES,
  type SampleConversation,
} from "@matsuri-ikoka/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSampleConversations, ReplayAgentRunner } from "../agent/replayRunner";
import type { AgentRunner } from "../agent/runner";
import { type AppDeps, createApp } from "../app";
import { createFestivalStore } from "../data/festivalStore";
import { testFestival } from "../domain/testFestivals";
import { createStationPointIndex } from "../domain/travelEstimate";
import { StoragePersistence } from "../session/persistence";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { MemoryTripStorage } from "../storage/memory";
import { DailyLimiter } from "./guard";

// 祭りを固定する API。祭りと駅は架空。

const ANCHOR = { festivalId: "suzunari-toro", date: "2026-08-16" };
const samplesDir = fileURLToPath(
  new URL("../../../../data/samples/conversations/", import.meta.url),
);

let samples: SampleConversation[];
beforeAll(async () => {
  samples = await loadSampleConversations(samplesDir);
});

const silentRunner = (mode: "live" | "mock"): AgentRunner => ({ mode, runTurn: async () => {} });

function setup(overrides: Partial<AppDeps> = {}) {
  const sessions = overrides.sessions ?? new SessionStore();
  const itineraries = new ItineraryStore();
  const deps: AppDeps = {
    runner: silentRunner("live"),
    sessions,
    itineraries,
    festivals: createFestivalStore([
      testFestival({ id: "suzunari-toro" }),
      testFestival({ id: "chushi-matsuri", status: "cancelled" }),
    ]),
    limiter: new DailyLimiter(null, () => "2026-08-03"),
    accessPasscode: null,
    today: () => "2026-08-03",
    stations: createStationPointIndex([["みなと中央", 35.0, 136.0]]),
    ...overrides,
  };
  const app = createApp(deps);
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, sessions, itineraries };
}

const preview = (over: Record<string, unknown> = {}) => ({
  sessionId: "s",
  anchor: ANCHOR,
  origin: "みなと中央駅",
  nights: 1,
  wishes: [],
  ...over,
});

describe("POST /api/festival-trips/preview", () => {
  it("組み立てを返し、選んだ条件を相談に残す", async () => {
    const { post, sessions } = setup();
    const session = sessions.create();

    const res = await post(
      "/api/festival-trips/preview",
      preview({ sessionId: session.id, wishes: ["京都府", "鈴鳴温泉"], pace: "relaxed" }),
    );

    expect(res.status).toBe(200);
    const plan = AnchorPlanSchema.parse(await res.json());
    expect(plan.anchor).toEqual(ANCHOR);
    expect(plan.visits.map((v) => v.name)).toEqual(["京都府", "鈴鳴温泉"]);
    expect(session.conditions).toMatchObject({
      origin: "みなと中央駅",
      nights: 1,
      pace: "relaxed",
      route: { shape: "auto", areas: ["京都府", "鈴鳴温泉"] },
    });
    // プレビューだけでは祭りを固定しない
    expect(session.anchor).toBeNull();
  });

  it("相談が見つからなくても、組み立ては返す", async () => {
    const res = await setup().post("/api/festival-trips/preview", preview());
    expect(res.status).toBe(200);
  });

  it.each([
    ["祭りがない", { anchor: { festivalId: "no-such", date: ANCHOR.date } }, 404],
    ["データにない日", { anchor: { ...ANCHOR, date: "2026-08-20" } }, 400],
    ["中止の回", { anchor: { festivalId: "chushi-matsuri", date: ANCHOR.date } }, 400],
    ["過ぎた日", { anchor: { festivalId: "suzunari-toro", date: "2026-08-16" }, today: true }, 400],
    ["形の誤り", { nights: 9 }, 400],
  ])("%s は断る", async (_name, over, status) => {
    const { today, ...body } = over as Record<string, unknown>;
    const { post } = setup(today ? { today: () => "2026-09-01" } : {});
    const res = await post("/api/festival-trips/preview", preview(body));
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
  });

  it("掲載停止の祭りは 404", async () => {
    const { post } = setup({
      festivals: createFestivalStore([testFestival({ id: "suzunari-toro", optOut: true })]),
    });
    const res = await post("/api/festival-trips/preview", preview());
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat の anchor", () => {
  const chat = (sessionId: string, anchor?: unknown) => ({
    sessionId,
    message: "この祭りで旅を作ってください",
    preferences: DEFAULT_PREFERENCES,
    ...(anchor === undefined ? {} : { anchor }),
  });

  it("確かめて相談の状態に残し、条件と組み立てに反映する", async () => {
    const { post, sessions } = setup();
    const session = sessions.create();
    await post("/api/festival-trips/preview", preview({ sessionId: session.id }));

    const res = await post("/api/chat", chat(session.id, ANCHOR));
    await res.text();

    expect(res.status).toBe(200);
    expect(session.anchor).toEqual(ANCHOR);
    expect(session.selectedFestivalId).toBe(ANCHOR.festivalId);
    expect(session.anchorPlan?.startDate).toBe(ANCHOR.date);
    expect(session.conditions.when).toEqual({
      kind: "range",
      from: ANCHOR.date,
      to: "2026-08-17",
    });
    expect(session.conditions.nights).toBe(1);
  });

  it("アンカーを送らない発言でも、固定は残る", async () => {
    const { post, sessions } = setup();
    const session = sessions.create();
    await (await post("/api/chat", chat(session.id, ANCHOR))).text();
    await (await post("/api/chat", chat(session.id))).text();

    expect(session.anchor).toEqual(ANCHOR);
  });

  it("別の祭りや日に変えたら、開催の確かめからやり直す", async () => {
    const { post, sessions } = setup({
      festivals: createFestivalStore([
        testFestival({ id: "suzunari-toro", date: "2026-08-16", endDate: "2026-08-17" }),
      ]),
    });
    const session = sessions.create();
    await (await post("/api/chat", chat(session.id, ANCHOR))).text();
    session.anchorCheck = "as_planned";

    await (await post("/api/chat", chat(session.id, ANCHOR))).text();
    expect(session.anchorCheck).toBe("as_planned");

    await (await post("/api/chat", chat(session.id, { ...ANCHOR, date: "2026-08-17" }))).text();
    expect(session.anchorCheck).toBeNull();
  });

  it.each([
    ["祭りがない", { festivalId: "no-such", date: ANCHOR.date }, 404],
    ["データにない日", { ...ANCHOR, date: "2026-08-20" }, 400],
  ])("%s は断り、相談の回数を使わない", async (_name, anchor, status) => {
    const limiter = new DailyLimiter(1, () => "2026-08-03");
    const { post, sessions } = setup({ limiter });
    const session = sessions.create();

    const res = await post("/api/chat", chat(session.id, anchor));

    expect(res.status).toBe(status);
    expect(session.anchor).toBeNull();
    expect(limiter.allows()).toBe(true);
  });

  it("保存の口を通して、別のインスタンスでも固定を続けられる", async () => {
    const storage = new MemoryTripStorage();
    const make = () => {
      const sessions = new SessionStore();
      const itineraries = new ItineraryStore();
      return {
        sessions,
        persistence: new StoragePersistence({ storage, sessions, itineraries }),
      };
    };
    const a = make();
    const first = setup(a);
    const session = a.sessions.create();
    await first.post("/api/festival-trips/preview", preview({ sessionId: session.id }));
    await (await first.post("/api/chat", chat(session.id, ANCHOR))).text();

    const b = make();
    const restored = await b.persistence.load(session.id);

    expect(restored?.anchor).toEqual(ANCHOR);
    expect(restored?.anchorPlan?.anchor).toEqual(ANCHOR);
    expect(restored?.selectedFestivalId).toBe(ANCHOR.festivalId);
  });

  it("前の形の保存（アンカーの項目がない）も読める。形の合わない組み立ては捨てる", async () => {
    const storage = new MemoryTripStorage();
    const base = {
      createdAt: 1,
      updatedAt: Date.now(),
      stage: "hearing" as const,
      conditions: {},
      preferences: DEFAULT_PREFERENCES,
      candidates: [],
      selectedFestivalId: null,
      itineraryId: null,
      replay: null,
    };
    await storage.saveSession({ ...base, id: "old" });
    await storage.saveSession({
      ...base,
      id: "stale",
      anchor: ANCHOR,
      anchorPlan: { festivalName: "形が古い" } as never,
    });
    const sessions = new SessionStore();
    const persistence = new StoragePersistence({
      storage,
      sessions,
      itineraries: new ItineraryStore(),
    });

    expect(await persistence.load("old")).toMatchObject({
      anchor: null,
      anchorPlan: null,
      anchorCheck: null,
      cancelledAnchor: null,
    });
    expect(await persistence.load("stale")).toMatchObject({ anchor: ANCHOR, anchorPlan: null });
  });
});

describe("サンプルの相談 suzunari-fixed-festival", () => {
  it("記録の再生で、祭りを固定したまま旅程としおりまで届く", async () => {
    const itineraries = new ItineraryStore();
    const sessions = new SessionStore();
    const { post } = setup({
      sessions,
      itineraries,
      runner: new ReplayAgentRunner(samples, itineraries, { speed: 0 }),
    });
    const created = await post("/api/session", { sample: "suzunari-fixed-festival" });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const sample = samples.find((s) => s.id === "suzunari-fixed-festival");
    expect(sample).toBeDefined();

    for (const turn of sample?.turns ?? []) {
      const res = await post("/api/chat", { sessionId, ...turn.request });
      expect(res.status).toBe(200);
      await res.text();
    }

    const session = sessions.get(sessionId);
    expect(session?.anchor).toEqual(ANCHOR);
    expect(session?.stage).toBe("shiori");
    const itinerary = itineraries.get(session?.itineraryId ?? "");
    expect(itinerary?.mainFestivalId).toBe(ANCHOR.festivalId);
    expect(itinerary?.days.some((d) => d.date === ANCHOR.date)).toBe(true);
    // 祭り調査係は呼ばない
    const tools = sample?.turns.flatMap((t) =>
      t.events.flatMap((e) => (e.event.type === "tool.start" ? [e.event.data.tool] : [])),
    );
    expect(tools).not.toContain("search_festivals");
    expect(tools).toContain("update_itinerary");
  });
});
