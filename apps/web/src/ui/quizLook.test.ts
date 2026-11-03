import { describe, expect, it } from "vitest";
import { choiceIcon, MAX_STAMP_DOTS, quizDots } from "./quizLook";

describe("quizDots", () => {
  it("はじめての問いは、今の問いの点を1つだけ出す", () => {
    expect(quizDots(0, false)).toEqual(["current"]);
  });

  it("集めたスタンプを塗り、答える前は今の問いの点を足す", () => {
    expect(quizDots(2, false)).toEqual(["stamp", "stamp", "current"]);
  });

  it("答えたあとは、集めたスタンプの点だけになる", () => {
    expect(quizDots(3, true)).toEqual(["stamp", "stamp", "stamp"]);
  });

  it("答えてもスタンプがなければ、空の点を1つ出す", () => {
    expect(quizDots(0, true)).toEqual(["empty"]);
  });

  it("点は上限の数までしか並べない", () => {
    expect(quizDots(12, false)).toHaveLength(MAX_STAMP_DOTS);
    expect(quizDots(12, false).every((dot) => dot === "stamp")).toBe(true);
  });
});

describe("choiceIcon", () => {
  it("祭りの種類の問いは、選択肢の種類の紋章にする", () => {
    expect(choiceIcon("category", "lantern")).toEqual({ type: "category", category: "lantern" });
  });

  it("地元の味の問いは食べものの絵、見どころの問いは見どころの絵にする", () => {
    expect(choiceIcon("local_food", "架空の団子")).toEqual({ type: "food" });
    expect(choiceIcon("highlight", "架空の行列")).toEqual({ type: "highlight" });
  });
});
