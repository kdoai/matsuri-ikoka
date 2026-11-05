import { type Festival, FestivalSchema } from "@matsuri-ikoka/schema";
import {
  fictionalFestival,
  fictionalItinerary,
  fictionalSource,
} from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { applyEvent } from "./events";
import { initialData } from "./initial";
import { conditionChips, mapPoints } from "./selectors";
import { soundCues } from "./sound-cues";
import { answerQuiz, beginTurn } from "./transitions";
import type { AppData } from "./types";
import {
  QUIZ_MS,
  QUIZ_RESULT_MS,
  shuffleDeck,
  slideDelayMs,
  slidePosition,
  TALK_MS,
  TALKS_PER_QUIZ,
  waitingSlide,
  waitingTalks,
} from "./waiting";

function festival(): Festival {
  return FestivalSchema.parse(fictionalFestival());
}

/** 2つ目の架空の祭り（踊りの祭り） */
function otherFestival(): Festival {
  const base = fictionalFestival();
  return FestivalSchema.parse({
    ...base,
    id: "kaede-odori",
    name: { ja: "楓の夜踊り" },
    category: "dance",
    highlights: ["夜通しの輪踊り"],
    trivia: [{ text: "踊りの輪は朝まで続く", source: fictionalSource("kaede") }],
    food: {
      stalls: "yes",
      local: [{ name: "楓まんじゅう", sources: [fictionalSource("kaede-food")] }],
    },
  });
}

function streaming(): AppData {
  const state = initialData();
  return beginTurn(state, {
    kind: "chat",
    message: "鈴鳴にします",
    preferences: state.preferences,
  });
}

/** 決まった順に 0〜1 を返す（テストでランダムの代わりに使う） */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

function candidate(festivalId: string, name: string) {
  return {
    festivalId,
    name,
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
}

describe("待ち時間の豆知識", () => {
  const empty = { current: null, previous: null, diff: null };

  it("候補が出る前は、読み込んである祭りのすべてから、祭りを交互に話す", () => {
    const a = festival();
    const b = otherFestival();
    const talks = waitingTalks({
      festivals: { [a.id]: a, [b.id]: b },
      candidates: [],
      itinerary: empty,
    });
    expect(talks.slice(0, 2).map((talk) => talk.festivalId)).toEqual([a.id, b.id]);
    expect(talks[0]).toMatchObject({
      kind: "trivia",
      festivalName: "鈴鳴灯籠まつり",
      text: a.trivia[0]?.text,
      source: a.trivia[0]?.source,
    });
  });

  it("小話・見どころ・作法を、データの文字列と出典のまま、種類が続かないように並べる", () => {
    const a = festival();
    const talks = waitingTalks({ festivals: { [a.id]: a }, candidates: [], itinerary: empty });
    expect(talks.slice(0, 3).map((talk) => talk.kind)).toEqual([
      "trivia",
      "highlight",
      "etiquette",
    ]);
    const highlight = talks.find((talk) => talk.kind === "highlight");
    expect(highlight).toMatchObject({ text: a.highlights[0], source: a.sources[0] });
    const etiquette = talks.filter((talk) => talk.kind === "etiquette");
    // 決まった値は code に、データの文はそのまま text に入れる
    expect(etiquette).toContainEqual(
      expect.objectContaining({ item: "participation", code: "join_by_application", text: "" }),
    );
    expect(etiquette).toContainEqual(
      expect.objectContaining({
        item: "photo",
        code: "restricted",
        text: "神事の間はフラッシュを使わない",
      }),
    );
    for (const talk of etiquette) expect(talk.source).toEqual(a.etiquette.sources[0]);
    // データにない話は作らない
    const texts = new Set([
      ...a.trivia.map((item) => item.text),
      ...a.highlights,
      "",
      "当日16時までに河原の受付で申し込む（灯籠1つ500円）",
      "灯籠は係の合図のあとに流す",
      "立入禁止の縄の内側に入らない",
      "歩きやすい靴",
      "懐中電灯",
      "神事の間はフラッシュを使わない",
      "見学と灯籠流しだけ。夜の河原は足元が暗い",
    ]);
    for (const talk of talks) expect(texts.has(talk.text)).toBe(true);
  });

  it("分からない作法（unknown）は話さない", () => {
    const base = fictionalFestival();
    const unknownEtiquette = FestivalSchema.parse({
      ...base,
      etiquette: {
        participation: "unknown",
        howToJoin: "unknown",
        rules: "unknown",
        dress: "unknown",
        bring: "unknown",
        risk: "unknown",
        photo: "unknown",
        sources: [],
      },
    });
    const talks = waitingTalks({
      festivals: { [unknownEtiquette.id]: unknownEtiquette },
      candidates: [],
      itinerary: empty,
    });
    expect(talks.some((talk) => talk.kind === "etiquette")).toBe(false);
  });

  it("候補が出たら、候補と主役の祭りから話す", () => {
    const a = festival();
    const b = otherFestival();
    const festivals = { [a.id]: a, [b.id]: b };
    const withCandidate = waitingTalks({
      festivals,
      candidates: [candidate(b.id, "楓の夜踊り")],
      itinerary: empty,
    });
    expect(new Set(withCandidate.map((talk) => talk.festivalId))).toEqual(new Set([b.id]));

    const itinerary = { ...fictionalItinerary(), mainFestivalId: a.id };
    const withMain = waitingTalks({
      festivals,
      candidates: [candidate(b.id, "楓の夜踊り")],
      itinerary: { current: itinerary, previous: null, diff: null },
    });
    expect(withMain[0]?.festivalId).toBe(a.id);
    expect(new Set(withMain.map((talk) => talk.festivalId))).toEqual(new Set([a.id, b.id]));
  });

  it("候補の祭りのデータがまだ届いていなければ、全体から話す", () => {
    const a = festival();
    const talks = waitingTalks({
      festivals: { [a.id]: a },
      candidates: [candidate("not-loaded", "まだの祭り")],
      itinerary: empty,
    });
    expect(talks.length).toBeGreaterThan(0);
  });
});

describe("豆知識のあいだのクイズ", () => {
  const deck = ["q1", "q2", "q3", "q4", "q5"];
  const slides = (from: number, to: number, talkCount: number, ids: readonly string[] = deck) =>
    Array.from({ length: to - from }, (_, i) => waitingSlide(from + i, talkCount, ids));

  it(`豆知識を ${TALKS_PER_QUIZ} 話話すごとに、クイズを1問挟む`, () => {
    expect(slides(0, 8, 6).map((slide) => slide?.kind)).toEqual([
      "talk",
      "talk",
      "talk",
      "quiz",
      "talk",
      "talk",
      "talk",
      "quiz",
    ]);
    expect(slides(0, 4, 6).filter((slide) => slide?.kind === "talk")).toEqual([
      { kind: "talk", talkIndex: 0 },
      { kind: "talk", talkIndex: 1 },
      { kind: "talk", talkIndex: 2 },
    ]);
  });

  it("同じ問いを続けて出さず、deck をひと巡りするまで問いが重ならない", () => {
    for (const talkCount of [0, 1, 2, 3, 7, 12]) {
      const quizzes = slides(0, 200, talkCount)
        .filter((slide) => slide?.kind === "quiz")
        .map((slide) => (slide?.kind === "quiz" ? slide.quizId : ""));
      expect(quizzes.length).toBeGreaterThan(deck.length);
      for (let i = 0; i + deck.length <= quizzes.length; i++) {
        expect(new Set(quizzes.slice(i, i + deck.length)).size).toBe(deck.length);
      }
    }
  });

  it("前へ戻ると、ひと回り前の並びを逆にたどる", () => {
    // 次へ送ってから前へ戻ると、元の1枚に戻る
    expect(waitingSlide(9 + 1 - 1, 6, deck)).toEqual(waitingSlide(9, 6, deck));
    expect(waitingSlide(-1, 6, deck)?.kind).toBe("quiz");
    expect(waitingSlide(-2, 6, deck)).toEqual({ kind: "talk", talkIndex: 5 });
  });

  it("豆知識がまだなくてもクイズは出し、豆知識が少なくてもひと回りに1問は出す", () => {
    expect(slides(0, 3, 0).map((slide) => slide?.kind)).toEqual(["quiz", "quiz", "quiz"]);
    expect(slides(0, 4, 1).map((slide) => slide?.kind)).toEqual(["talk", "quiz", "talk", "quiz"]);
  });

  it("クイズがなければ豆知識だけ、どちらもなければ何も出さない", () => {
    expect(slides(0, 5, 3, []).every((slide) => slide?.kind === "talk")).toBe(true);
    expect(waitingSlide(0, 0, [])).toBeNull();
  });

  it("点の数はひと回りの枚数で、いまの位置は負の数でも収まる", () => {
    expect(slidePosition(5, 6, deck)).toEqual({ count: 8, index: 5 });
    expect(slidePosition(-1, 6, deck)).toEqual({ count: 8, index: 7 });
    expect(slidePosition(0, 0, [])).toEqual({ count: 1, index: 0 });
  });

  it("クイズは豆知識より長く見せ、答えたら解説を読む時間をとる", () => {
    expect(slideDelayMs({ kind: "talk", talkIndex: 0 }, false)).toBe(TALK_MS);
    expect(slideDelayMs({ kind: "quiz", quizId: "q1" }, false)).toBe(QUIZ_MS);
    expect(slideDelayMs({ kind: "quiz", quizId: "q1" }, true)).toBe(QUIZ_RESULT_MS);
    expect(QUIZ_MS).toBeGreaterThan(TALK_MS);
  });

  it("混ぜた deck は、ID を重ねずにすべて含む", () => {
    const shuffled = shuffleDeck([...deck, "q1"], sequence(0.9, 0.1, 0.5, 0.3));
    expect([...shuffled].sort()).toEqual(deck);
    expect(shuffleDeck([], sequence(0.5))).toEqual([]);
  });

  it("正解するとスタンプが1つ増え、答え直しはできない", () => {
    const quiz = {
      id: "q1",
      question: "架空の問い",
      choices: ["A", "B", "C"],
      answer: 2,
      explanation: "架空の解説",
      source: fictionalSource("quiz"),
    };
    let state = answerQuiz(streaming(), quiz, 2);
    expect(state.stamps).toBe(1);
    expect(state.quiz.answers).toEqual({ q1: 2 });
    state = answerQuiz(state, quiz, 0);
    expect(state.stamps).toBe(1);
    expect(state.quiz.answers).toEqual({ q1: 2 });
  });

  it("はずれではスタンプは増えず、選択肢の外は受け付けない", () => {
    const quiz = {
      id: "q2",
      question: "架空の問い",
      choices: ["A", "B"],
      answer: 0,
      explanation: "架空の解説",
      source: fictionalSource("quiz"),
    };
    expect(answerQuiz(streaming(), quiz, 1).stamps).toBe(0);
    expect(answerQuiz(streaming(), quiz, 5).quiz.answers).toEqual({});
  });
});

describe("条件のチップ", () => {
  it("読み取れた条件だけを、決まった順に出す", () => {
    expect(conditionChips({}, "train")).toEqual([]);
    expect(
      conditionChips(
        {
          when: { kind: "date", date: "2026-08-16" },
          origin: "みなと中央駅",
          party: { adults: 2, children: 1 },
        },
        "car",
      ),
    ).toEqual([
      { key: "date", value: "2026-08-16" },
      { key: "origin", value: "みなと中央駅" },
      { key: "party", value: "2/1" },
      { key: "move", value: "car" },
    ]);
  });
});

describe("地図の点", () => {
  it("旅程の予定を順番どおりに並べ、主役の会場を見分け、旅程にない寄り道を足す", () => {
    const itinerary = fictionalItinerary();
    const points = mapPoints(itinerary, [
      {
        spotId: "suzunari-craft-hall",
        name: "鈴鳴和紙の館",
        kind: "sightseeing",
        location: { lat: 35.121, lng: 136.083 },
      },
      { spotId: "riverside", name: "川べり", kind: "rest", location: { lat: 35.1, lng: 136.1 } },
    ]);
    expect(points.map((point) => [point.name, point.kind, point.order])).toEqual([
      ["鈴鳴和紙の館", "stop", 1],
      ["鈴鳴灯籠まつり", "venue", 2],
      ["川べり", "spot", null],
    ]);
  });
});

describe("効果音", () => {
  it("スタッフが動き出したら拍子木、候補が届いたら太鼓", () => {
    const before = streaming();
    const walking = applyEvent(before, {
      type: "staff.start",
      data: { staff: "researcher", task: "find_festivals", bubble: "調べます" },
    });
    expect(soundCues(before, walking)).toEqual(["hyoshigi"]);

    const started = applyEvent(walking, {
      type: "tool.start",
      data: { toolCallId: "a", tool: "search_festivals", staff: "researcher", bubble: "探します" },
    });
    const found = applyEvent(started, {
      type: "tool.end",
      data: {
        toolCallId: "a",
        tool: "search_festivals",
        staff: "researcher",
        ok: true,
        bubble: "1件",
        count: 1,
        candidates: [
          {
            festivalId: "suzunari-toro",
            name: "鈴鳴灯籠まつり",
            date: "2026-08-16",
            start: "18:30",
            end: "21:00",
            venueName: "河原",
            place: "鈴鳴町",
            daysFromWish: 0,
            confidence: "official",
            confirmed: true,
            highlight: "灯籠",
            source: fictionalSource("2026"),
          },
        ],
      },
    });
    expect(soundCues(started, found)).toEqual(["taiko"]);
    expect(soundCues(found, found)).toEqual([]);
  });
});
