import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PREFERENCES, type SseEvent } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { loadSampleConversations, ReplayAgentRunner } from "./replayRunner";

const samplesDir = fileURLToPath(
  new URL("../../../../data/samples/conversations/", import.meta.url),
);

async function setup() {
  const samples = await loadSampleConversations(samplesDir);
  const itineraries = new ItineraryStore();
  const runner = new ReplayAgentRunner(samples, itineraries, { speed: 0 });
  const session = new SessionStore().create({ replay: { sampleId: samples[0]!.id, nextTurn: 0 } });
  const turn = async () => {
    const events: SseEvent[] = [];
    await runner.runTurn(
      {
        session,
        message: "（再生では使わない）",
        preferences: DEFAULT_PREFERENCES,
        signal: new AbortController().signal,
      },
      (event) => events.push(event),
    );
    return events;
  };
  return { samples, itineraries, session, turn };
}

describe("ReplayAgentRunner", () => {
  it("サンプルの相談を発言ごとに、記録したイベントの順で再生する（done は呼び出し側が送る）", async () => {
    const { samples, session, turn } = await setup();
    const recorded = samples[0]!.turns[0]!.events.map((e) => e.event);

    const events = await turn();

    expect(events).toEqual(recorded.filter((e) => e.type !== "done"));
    const done = recorded.at(-1)!;
    expect(done.type).toBe("done");
    if (done.type !== "done") return;
    expect(session.stage).toBe(done.data.stage);
    expect(session.conditions).toEqual(done.data.conditions);
    expect(session.preferences).toEqual(done.data.preferences);
    expect(session.candidates.length).toBeGreaterThan(0);
  });

  it("旅程を保存し、再確認の結果を旅程に反映する", async () => {
    const { samples, itineraries, session, turn } = await setup();

    for (const _ of samples[0]!.turns) await turn();

    const itinerary = itineraries.get(session.itineraryId!);
    expect(itinerary?.verification.status).toBe("as_planned");
    expect(session.stage).toBe("shiori");
  });

  it("記録の終わりのあとは、そのことを伝えるだけにする", async () => {
    const { samples, turn } = await setup();
    for (const _ of samples[0]!.turns) await turn();

    const events = await turn();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("message.delta");
  });

  it("記録の間隔で待ち、止められたら途中でやめる", async () => {
    const samples = await loadSampleConversations(samplesDir);
    const runner = new ReplayAgentRunner(samples, new ItineraryStore(), { speed: 1 });
    const session = new SessionStore().create();
    const controller = new AbortController();
    const events: SseEvent[] = [];
    setTimeout(() => controller.abort(new Error("stop")), 50);

    await expect(
      runner.runTurn(
        { session, message: "x", preferences: DEFAULT_PREFERENCES, signal: controller.signal },
        (event) => events.push(event),
      ),
    ).rejects.toThrow("stop");
    expect(events.length).toBeLessThan(samples[0]!.turns[0]!.events.length - 1);
    expect(path.isAbsolute(samplesDir)).toBe(true);
  });
});
