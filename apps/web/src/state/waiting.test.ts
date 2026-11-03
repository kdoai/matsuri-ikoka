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
import { answerQuiz, beginTurn, expectedWaitMs, offerQuiz, shouldOfferQuiz } from "./transitions";
import type { AppData } from "./types";
import { buildQuiz, waitingTalks } from "./waiting";

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

describe("クイズ", () => {
  it("ほかの祭りのデータからはずれの選択肢を作り、正解は問う祭りのもの", () => {
    const a = festival();
    const b = otherFestival();
    for (const seed of [0, 0.3, 0.6, 0.9]) {
      const question = buildQuiz({ [a.id]: a, [b.id]: b }, a.id, sequence(seed, 0.99 - seed))!;
      expect(question.festivalId).toBe(a.id);
      const right = question.choices[question.correct];
      const wrong = question.choices[question.correct === 0 ? 1 : 0];
      if (question.kind === "highlight") {
        expect(a.highlights).toContain(right);
        expect(b.highlights).toContain(wrong);
      } else if (question.kind === "local_food") {
        expect(right).toBe("鈴鳴そば");
        expect(wrong).toBe("楓まんじゅう");
      } else {
        expect(right).toBe("lantern");
        expect(wrong).not.toBe("lantern");
      }
    }
  });

  it("祭りが1つだけでも、種類のクイズは作れる", () => {
    const a = festival();
    const question = buildQuiz({ [a.id]: a }, a.id, sequence(0.99, 0.2, 0.7));
    expect(question?.kind).toBe("category");
  });

  it("祭りのデータがなければ、クイズは出さない", () => {
    expect(buildQuiz({}, null)).toBeNull();
  });

  it("10秒以上待ちそうなときだけ、1つの発言に1問出す", () => {
    let state = applyEvent(streaming(), {
      type: "staff.start",
      data: { staff: "researcher", task: "find_festivals", bubble: "調べます" },
    });
    expect(expectedWaitMs(state)).toBeLessThan(10_000);
    expect(shouldOfferQuiz(state)).toBe(false);

    state = applyEvent(state, {
      type: "staff.start",
      data: { staff: "planner", task: "plan_route", bubble: "道のりを調べます" },
    });
    expect(shouldOfferQuiz(state)).toBe(true);

    const a = festival();
    state = offerQuiz(state, buildQuiz({ [a.id]: a }, a.id, sequence(0.1))!);
    expect(shouldOfferQuiz(state)).toBe(false);
  });

  it("確定前の再確認は待ち時間が長いので、クイズを出す", () => {
    const state = applyEvent(streaming(), {
      type: "tool.start",
      data: { toolCallId: "v", tool: "verify_festival", staff: "concierge", bubble: "確かめます" },
    });
    expect(shouldOfferQuiz(state)).toBe(true);
  });

  it("正解するとスタンプが1つ増え、答え直しはできない", () => {
    const a = festival();
    const question = buildQuiz({ [a.id]: a }, a.id, sequence(0.1))!;
    let state = offerQuiz(streaming(), question);
    state = answerQuiz(state, question.correct);
    expect(state.stamps).toBe(1);
    state = answerQuiz(state, question.correct);
    expect(state.stamps).toBe(1);
  });

  it("返答が終わると、クイズは閉じる", () => {
    const a = festival();
    let state = offerQuiz(streaming(), buildQuiz({ [a.id]: a }, a.id, sequence(0.1))!);
    state = applyEvent(state, {
      type: "done",
      data: { stage: "itinerary", conditions: {}, preferences: state.preferences },
    });
    expect(state.quiz.question).toBeNull();
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
