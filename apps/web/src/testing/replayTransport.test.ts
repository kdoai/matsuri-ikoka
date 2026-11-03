import { decodeSseEvent, SampleConversationSchema, type SseMessage } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import sampleJson from "../../../../data/samples/conversations/suzunari-day-trip.json";
import { createReplayTransport, replayTurn, type Sleep } from "./replayTransport";

const sample = SampleConversationSchema.parse(sampleJson);

function recordingSleep(): { sleep: Sleep; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

describe("テスト用の記録の再生", () => {
  it("記録した間隔のとおりに待ち、SSE の1件として渡す", async () => {
    const { sleep, waits } = recordingSleep();
    const received: SseMessage[] = [];
    const events = sample.turns[0]!.events;
    await replayTurn(events, (message) => received.push(message), new AbortController().signal, {
      sleep,
    });
    expect(received.map((message) => decodeSseEvent(message))).toEqual(
      events.map((recorded) => recorded.event),
    );
    const gaps = events.slice(1).map((recorded, index) => recorded.atMs - events[index]!.atMs);
    expect(waits).toEqual(gaps.filter((gap) => gap > 0));
  });

  it("速さを上げると、待つ時間が縮む", async () => {
    const { sleep, waits } = recordingSleep();
    await replayTurn(sample.turns[0]!.events, () => {}, new AbortController().signal, {
      sleep,
      speed: 4,
    });
    expect(waits[0]).toBe(100);
  });

  it("中止されたら、そこで止める", async () => {
    const controller = new AbortController();
    const received: SseMessage[] = [];
    const sleep: Sleep = async () => {
      controller.abort();
    };
    await expect(
      replayTurn(sample.turns[0]!.events, (message) => received.push(message), controller.signal, {
        sleep,
      }),
    ).rejects.toThrow();
    expect(received).toHaveLength(1);
  });

  it("送るたびに、記録の次の発言への返答を流す", async () => {
    const transport = createReplayTransport(sample, { sleep: async () => {} });
    await transport.startSession();
    const stages: string[] = [];
    for (const _turn of sample.turns) {
      await transport.chat(
        { sessionId: "s", message: "なんでも", preferences: sample.turns[0]!.request.preferences },
        (message) => {
          if (message.event === "done") {
            stages.push(JSON.parse(message.data).stage);
          }
        },
        new AbortController().signal,
      );
    }
    expect(stages).toEqual(["candidates", "itinerary", "itinerary", "shiori"]);
  });
});
