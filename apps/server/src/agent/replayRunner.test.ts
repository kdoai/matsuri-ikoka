import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PREFERENCES, type SseEvent } from "@matsuri-ikoka/schema";
import { describe, expect, it, vi } from "vitest";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { loadSampleConversations, ReplayAgentRunner, sleep } from "./replayRunner";

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
    const again = await turn();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("message.delta");
    // 返答ごとに別の messageId にする（同じだと、画面が前の返答につなげてしまう）
    const id = (e: SseEvent | undefined) => (e?.type === "message.delta" ? e.data.messageId : null);
    expect(id(again[0])).not.toBe(id(events[0]));
  });

  it("再生の速さは倍率。大きいほど速い", async () => {
    const samples = await loadSampleConversations(samplesDir);
    const recordedMs = samples[0]!.turns[0]!.events.at(-1)!.atMs;
    const runner = new ReplayAgentRunner(samples, new ItineraryStore(), { speed: 100 });
    const session = new SessionStore().create();

    const started = Date.now();
    await runner.runTurn(
      {
        session,
        message: "x",
        preferences: DEFAULT_PREFERENCES,
        signal: new AbortController().signal,
      },
      () => {},
    );

    expect(Date.now() - started).toBeLessThan(recordedMs / 2);
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

describe("sleep", () => {
  it("止められていれば、待ち時間が0でも止める", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(sleep(0, controller.signal)).rejects.toThrow("stop");
  });

  it("待ち終えたら abort のリスナーを外す", async () => {
    const { signal } = new AbortController();
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");

    await sleep(5, signal);

    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  });
});
