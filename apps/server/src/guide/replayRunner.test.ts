import { fileURLToPath } from "node:url";
import {
  GUIDE_TOOL_NAMES,
  type GuideSseEvent,
  type Itinerary,
  type SampleGuide,
} from "@matsuri-ikoka/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { CostMeter } from "../agent/costMeter";
import { type Session, SessionStore } from "../session/sessionStore";
import { sessionGuideData } from "./data";
import { proposalContentHash } from "./proposal";
import { loadSampleGuides, ReplayGuideRunner } from "./replayRunner";
import { newGuideTurn } from "./runner";

// 架空の祭りの、記録したガイドの相談を再生する

const root = (relative: string) =>
  fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));

let samples: SampleGuide[];

beforeAll(async () => {
  samples = await loadSampleGuides(root("data/samples/guide"));
});

/** 記録の提案のもとになった旅に、別の ID を付けたもの */
const tripOf = (sample: SampleGuide): Itinerary => {
  const proposal = sample.proposals[0];
  if (proposal === undefined) throw new Error("提案がありません");
  return { ...proposal.itinerary, id: "trip-this-session", version: proposal.baseVersion };
};

function setup() {
  const sample = samples[0] as SampleGuide;
  const runner = new ReplayGuideRunner(samples, { speed: 0 });
  const session = new SessionStore().create();
  const itinerary = tripOf(sample);
  session.itineraryId = itinerary.id;
  const data = sessionGuideData(session.guide);
  const trip = { itinerary, data };
  const say = async (message: string, emergency = false, target: Session = session) => {
    const events: GuideSseEvent[] = [];
    const turn = newGuideTurn();
    await runner.runTurn(
      {
        session: target,
        trip,
        message,
        emergency,
        budgetUsd: 1,
        turn,
        meter: new CostMeter(),
        signal: new AbortController().signal,
      },
      (event) => events.push(event),
    );
    return { events, turn };
  };
  return { sample, runner, session, itinerary, data, trip, say };
}

describe("ReplayGuideRunner", () => {
  it("旅の時期は、記録の「話した日」で決める", () => {
    const { runner, sample } = setup();
    expect(runner.today()).toBe(sample.today);
    expect(runner.now().startsWith(sample.today)).toBe(true);
  });

  it("記録の通知と提案を、この旅に置き換えて1回だけ届ける", async () => {
    const { runner, session, trip, data, itinerary, sample } = setup();

    await runner.prepare(session, trip);
    await data.putNotice({ ...(await data.notices())[0]!, summary: "読み直しても消えない" });
    await runner.prepare(session, trip);

    const notices = await data.notices();
    const proposals = await data.proposals();
    expect(notices.map((notice) => notice.tripId)).toEqual([itinerary.id]);
    expect(notices[0]?.summary).toBe("読み直しても消えない");
    expect(proposals[0]?.tripId).toBe(itinerary.id);
    expect(proposals[0]?.itinerary.id).toBe(itinerary.id);
    expect(proposals[0]?.itinerary.version).toBe(itinerary.version + 1);
    expect(proposals[0]?.contentHash).toBe(
      proposalContentHash(proposals[0]?.itinerary as Itinerary),
    );
    expect(proposals[0]?.contentHash).not.toBe(sample.proposals[0]?.contentHash);
    expect((await data.watch())?.tripId).toBe(itinerary.id);
  });

  it("主役の祭りや旅の日が違う旅には、記録の通知と提案を届けない", async () => {
    const { runner, session, data, itinerary } = setup();

    await runner.prepare(session, {
      data,
      itinerary: { ...itinerary, mainFestivalId: "kazami-bon-odori" },
    });

    expect(await data.notices()).toEqual([]);
    expect(await data.proposals()).toEqual([]);
    expect(await data.watch()).toBeNull();
  });

  it("主役の祭りや旅の日が違う旅には、再生でも記録の通知と提案を流さない", async () => {
    const { runner, session, itinerary, data } = setup();
    const events: GuideSseEvent[] = [];

    await runner.runTurn(
      {
        session,
        trip: { data, itinerary: { ...itinerary, mainFestivalId: "kazami-bon-odori" } },
        message: "留守の間に、何か変わったことはありましたか",
        emergency: false,
        budgetUsd: 1,
        turn: newGuideTurn(),
        meter: new CostMeter(),
        signal: new AbortController().signal,
      },
      (event) => events.push(event),
    );

    const types = events.map((event) => event.type);
    expect(types).toContain("message.delta");
    expect(types).not.toContain("guide.notice");
    expect(types).not.toContain("guide.proposal");
  });

  it("当てられる旅には、記録の通知を、この旅に置き換えて流す", async () => {
    const { say, itinerary } = setup();

    const { events } = await say("留守の間に、何か変わったことはありましたか");

    const notice = events.find((event) => event.type === "guide.notice");
    expect(notice?.type === "guide.notice" && notice.data.notice.tripId).toBe(itinerary.id);
  });

  it("発言が記録と同じならその返答を流し、連絡先と終わりのイベントは流さない", async () => {
    const { say, data } = setup();

    const { events, turn } = await say("連れは歩くのがゆっくりなので、気にしてもらえますか");

    expect(events.map((event) => event.type)).toEqual([
      "guide.tool.start",
      "guide.tool.end",
      "guide.memo",
      "message.delta",
    ]);
    expect(turn.toolCalls).toEqual(["save_memo"]);
    expect(GUIDE_TOOL_NAMES).toContain(turn.toolCalls[0]);
    expect((await data.memo()).map((item) => item.text)).toEqual(["連れは歩くのがゆっくり"]);
  });

  it("緊急なら緊急の案内の記録を流し、連絡先のイベントは呼び出し側に任せる", async () => {
    const { say } = setup();

    const { events } = await say("階段で転んで頭を打ちました", true);

    expect(events.map((event) => event.type)).toEqual(["message.delta"]);
    expect(JSON.stringify(events)).toContain("119");
  });

  it("違う発言には、まだ流していない次の記録を順に流し、緊急の案内は飛ばす", async () => {
    const { say, sample } = setup();
    const plain = sample.turns.filter(
      (turn) => !turn.events.some(({ event }) => event.type === "guide.emergency"),
    );

    for (const _ of plain) {
      const { events } = await say("なんでも聞いてよいですか");
      expect(events.map((event) => event.type)).not.toContain("guide.emergency");
    }
    const { events } = await say("なんでも聞いてよいですか");

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).toContain("ここまで");
  });
});
