import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type GuideNotice,
  type GuideProposal,
  GuideProposalSchema,
  type GuideSseEvent,
  type IsoDate,
  type Itinerary,
  ItinerarySchema,
  type SampleGuide,
  SampleGuideSchema,
  type SampleGuideTurn,
} from "@matsuri-ikoka/schema";
import { sleep } from "../agent/replayRunner";
import { randomId, type Session } from "../session/sessionStore";
import type { GuideTrip } from "./data";
import { proposalContentHash } from "./proposal";
import type { EmitGuideEvent, GuideRunner, GuideTurnInput } from "./runner";

// mock：記録したガイドの相談（data/samples/guide/*.json）を再生する。キーなしで、通知・提案・手帳・緊急の案内を確かめる。
// 発言が記録と同じならその返答を、違えば次の返答を流す。緊急の言葉があるときは、緊急の案内の記録を流す。
// 記録の旅は、いま開いている相談の旅に置き換える（相談どうしで混ざらないように）。

const END_OF_SAMPLE =
  "このサンプルのガイドの相談はここまでです。もう一度試すときは、新しい相談を始めてください。";

export async function loadSampleGuides(dir: string): Promise<SampleGuide[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (name) =>
      SampleGuideSchema.parse(JSON.parse(await readFile(path.join(dir, name), "utf8"))),
    ),
  );
}

/** 記録の提案を、今の旅の次の版の提案に置き換える。ID と版が変わるので、ハッシュも計算し直す */
function localizeProposal(proposal: GuideProposal, itinerary: Itinerary): GuideProposal {
  const version = itinerary.version + 1;
  const proposed = ItinerarySchema.parse({
    ...proposal.itinerary,
    id: itinerary.id,
    version,
    days: proposal.itinerary.days.map((day) => ({
      ...day,
      items: day.items.map((item) => ({
        ...item,
        changedInVersion: Math.min(item.changedInVersion, version),
      })),
    })),
  });
  return GuideProposalSchema.parse({
    ...proposal,
    tripId: itinerary.id,
    baseVersion: itinerary.version,
    itinerary: proposed,
    contentHash: proposalContentHash(proposed),
    diff: { ...proposal.diff, fromVersion: itinerary.version, toVersion: version },
  });
}

const localizeNotice = (notice: GuideNotice, itinerary: Itinerary): GuideNotice => ({
  ...notice,
  tripId: itinerary.id,
});

/** 記録の提案を、この旅に当てられるか。主役の祭りと旅の日が同じときだけ当てる */
function fitsTrip(proposal: GuideProposal, itinerary: Itinerary): boolean {
  const dates = (it: Itinerary) => it.days.map((day) => day.date).join(",");
  return (
    proposal.itinerary.mainFestivalId === itinerary.mainFestivalId &&
    dates(proposal.itinerary) === dates(itinerary)
  );
}

export class ReplayGuideRunner implements GuideRunner {
  readonly mode = "mock" as const;
  readonly #sample: SampleGuide;
  /** 再生の速さの倍率。1 で記録どおり、0 で待たない */
  readonly #speed: number;

  constructor(samples: readonly SampleGuide[], options: { speed?: number } = {}) {
    const [sample] = samples;
    if (sample === undefined) throw new Error("サンプルのガイドの相談がありません");
    this.#sample = sample;
    this.#speed = options.speed ?? 1;
  }

  /** 旅の時期は、記録の「話した日」で決める（記録の旅は、実際の今日とは関係がない） */
  today(): IsoDate {
    return this.#sample.today;
  }

  now(): string {
    return `${this.#sample.today}T12:00:00+09:00`;
  }

  /** 記録の見回りの依頼・通知・提案を、この相談の旅に届ける。旅に当てられない記録は届けない */
  async prepare(session: Session, trip: GuideTrip): Promise<void> {
    if (session.guide.replaySeeded) return;
    session.guide.replaySeeded = true;
    const { itinerary, data } = trip;
    const proposals = this.#sample.proposals.filter((p) => fitsTrip(p, itinerary));
    if (proposals.length === 0) return;
    await data.putWatch({ ...this.#sample.watch, tripId: itinerary.id });
    for (const notice of this.#sample.notices) {
      await data.putNotice(localizeNotice(notice, itinerary));
    }
    for (const proposal of proposals) {
      await data.putProposal(localizeProposal(proposal, itinerary));
    }
  }

  /** 流す記録を選ぶ。同じ発言があればそれ。緊急なら緊急の案内。それ以外は、まだ流していない次の記録 */
  #pick(input: GuideTurnInput): { turn: SampleGuideTurn; index: number } | null {
    const turns = this.#sample.turns;
    const played = input.session.guide.replayedTurns;
    const isEmergencyTurn = (turn: SampleGuideTurn) =>
      turn.events.some(({ event }) => event.type === "guide.emergency");
    const index = [
      turns.findIndex((turn) => turn.request.message === input.message.trim()),
      input.emergency ? turns.findIndex(isEmergencyTurn) : -1,
      input.emergency
        ? -1
        : turns.findIndex((turn, at) => !played.includes(at) && !isEmergencyTurn(turn)),
    ].find((found) => found !== -1);
    const turn = index === undefined ? undefined : turns[index];
    return turn === undefined || index === undefined ? null : { turn, index };
  }

  async runTurn(input: GuideTurnInput, emit: EmitGuideEvent): Promise<void> {
    const { signal, trip, session } = input;
    const { itinerary, data } = trip;
    const picked = this.#pick(input);
    if (picked === null) {
      emit({ type: "message.delta", data: { messageId: randomId("end"), text: END_OF_SAMPLE } });
      return;
    }
    const replayed = new Set(session.guide.replayedTurns).add(picked.index);
    session.guide.replayedTurns = [...replayed];
    let elapsed = 0;
    for (const recorded of picked.turn.events) {
      const wait = this.#speed === 0 ? 0 : (recorded.atMs - elapsed) / this.#speed;
      await sleep(wait, signal);
      elapsed = recorded.atMs;
      const event: GuideSseEvent = recorded.event;
      switch (event.type) {
        // 連絡先と終わりのイベントは、呼び出し側が送る
        case "guide.emergency":
        case "guide.done":
          break;
        case "guide.notice":
          // 記録の通知は、当てられる旅にだけ届ける（prepare と同じ）
          if (!this.#sample.proposals.some((proposal) => fitsTrip(proposal, itinerary))) break;
          emit({
            type: "guide.notice",
            data: { notice: localizeNotice(event.data.notice, itinerary) },
          });
          break;
        case "guide.proposal": {
          if (!fitsTrip(event.data.proposal, itinerary)) break;
          const proposal = localizeProposal(event.data.proposal, itinerary);
          await data.putProposal(proposal);
          emit({ type: "guide.proposal", data: { proposal } });
          break;
        }
        case "guide.memo":
          await data.putMemo(event.data.item);
          emit(event);
          break;
        case "guide.tool.start":
          input.turn.toolCalls.push(event.data.tool);
          emit(event);
          break;
        default:
          emit(event);
      }
    }
  }
}
