import type { ConversationStage, Itinerary } from "@matsuri-ikoka/schema";
import { fictionalItinerary, fictionalSource } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../i18n";
import { initialData } from "./initial";
import { selectSceneProps } from "./scene";
import { proposalShown } from "./selectors";
import type { AppData } from "./types";
import { WAIT_LINE_MS, waitLineIndex, waitPhase } from "./waitLines";

const candidate = {
  festivalId: "kaede-odori",
  name: "楓の夜踊り",
  date: "2026-08-16",
  start: null,
  end: null,
  venueName: "広場",
  place: "架空の町",
  daysFromWish: 0,
  confidence: "single" as const,
  confirmed: false,
  highlight: "夜通しの輪踊り",
  source: fictionalSource("kaede"),
};

function waitingAfter(
  text: string,
  stage: ConversationStage,
  options: { itinerary?: Itinerary } = {},
): AppData {
  const base = initialData();
  return {
    ...base,
    session: { ...base.session, stage, streaming: true },
    messages: [{ kind: "user", id: "u1", text }],
    candidates: [candidate],
    itinerary: { current: options.itinerary ?? null, previous: null, diff: null },
  };
}

describe("返答を待つ間のひとこと", () => {
  it("聞き取りの間は、祭りを探す段階のひとことを出す", () => {
    expect(waitPhase(waitingAfter("夏に行きたい", "hearing"))).toBe("search");
    expect(waitPhase(waitingAfter("ほかの祭りも見たい", "candidates"))).toBe("search");
  });

  it("候補から祭りを選んだら、旅程を組む段階のひとことにする（どちらの言語で選んでも）", () => {
    for (const messages of Object.values(MESSAGES)) {
      const text = messages.candidates.chooseMessage(candidate.name);
      expect(waitPhase(waitingAfter(text, "candidates"))).toBe("plan");
    }
  });

  it("旅程の直しを頼んだ間は、旅程を組む段階のひとことにする", () => {
    const state = waitingAfter("もう少しゆっくり", "revising", {
      itinerary: fictionalItinerary(),
    });
    expect(waitPhase(state)).toBe("plan");
  });

  it("「決定」を送ったら、しおりを作る段階のひとことにし、最初は取りかかる文から始める", () => {
    for (const messages of Object.values(MESSAGES)) {
      const state = waitingAfter(messages.dialogue.replies.decideMessage, "revising", {
        itinerary: fictionalItinerary(),
      });
      expect(waitPhase(state)).toBe("shiori");
    }
    expect(MESSAGES.ja.dialogue.waitLines.shiori[0]).toBe("しおりの作成に取りかかりますね");
    expect(waitPhase(waitingAfter("確かめて", "verifying"))).toBe("shiori");
  });

  it("どの段階にも、入れ替えるひとことが2つ以上あり、言語ごとに数がそろう", () => {
    for (const phase of ["search", "plan", "shiori"] as const) {
      expect(MESSAGES.ja.dialogue.waitLines[phase].length).toBeGreaterThan(1);
      expect(MESSAGES.en.dialogue.waitLines[phase]).toHaveLength(
        MESSAGES.ja.dialogue.waitLines[phase].length,
      );
    }
  });

  it("5秒おきに次のひとことへ移り、最後まで行ったら最初に戻る", () => {
    expect(WAIT_LINE_MS).toBe(5_000);
    expect(waitLineIndex(0, 4)).toBe(0);
    expect(waitLineIndex(4_999, 4)).toBe(0);
    expect(waitLineIndex(5_000, 4)).toBe(1);
    expect(waitLineIndex(15_000, 4)).toBe(3);
    expect(waitLineIndex(20_000, 4)).toBe(0);
  });

  it("時刻がずれて経過が負になっても、ひとことがなくても、最初の位置を返す", () => {
    expect(waitLineIndex(-1_000, 4)).toBe(0);
    expect(waitLineIndex(12_000, 0)).toBe(0);
  });
});

describe("旅程の提案が出たあと", () => {
  it("提案が出るまでは豆知識の窓を出し、出たあとは出さない。スタッフも待機位置から動かない", () => {
    const before = initialData();
    expect(proposalShown(before)).toBe(false);
    expect(selectSceneProps(before, false).calm).toBe(false);

    const after = { ...before, itinerary: { ...before.itinerary, current: fictionalItinerary() } };
    expect(proposalShown(after)).toBe(true);
    expect(selectSceneProps(after, false).calm).toBe(true);
  });
});
