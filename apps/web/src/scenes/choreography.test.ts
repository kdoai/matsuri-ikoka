import { describe, expect, it } from "vitest";
import { IDLE_STAFF } from "../state/initial";
import type { StaffState } from "../state/types";
import {
  exteriorOpacity,
  facingYaw,
  frameView,
  LETTER_ARC,
  letterPoint,
  playerPlan,
  staffPlan,
  turnToward,
  WALK_SPEED,
  walkStep,
} from "./choreography";

function staff(patch: Partial<StaffState>): StaffState {
  return { ...IDLE_STAFF, ...patch };
}

const DESIGN_YFOV = 0.39959652046304894; // cam.main の縦の画角（16:9 で 22.9°）

describe("誰がどこで何をするか", () => {
  it("待機では待機位置で idle、持ち場へ向かう間は歩いて、着いたら作業の動きを待つ", () => {
    expect(staffPlan("researcher", IDLE_STAFF, false)).toMatchObject({
      spot: "home",
      motion: "idle",
      face: "normal",
      props: [],
    });
    expect(
      staffPlan(
        "researcher",
        staff({ phase: "walking", motion: "walk", task: "find_festivals" }),
        false,
      ),
    ).toMatchObject({ spot: "post", motion: "idle", travel: "walk" });
  });

  it("作業の動きと小物：調査係は本をめくり、周辺係は地図を指し、旅程係は時刻表を見上げる", () => {
    expect(
      staffPlan("researcher", staff({ phase: "working", motion: "flip" }), false),
    ).toMatchObject({
      spot: "post",
      motion: "flip",
      face: "determined",
      props: ["prop.book"],
      once: false,
    });
    expect(staffPlan("scout", staff({ phase: "working", motion: "point" }), false)).toMatchObject({
      motion: "point",
      props: ["prop.map"],
    });
    expect(
      staffPlan("planner", staff({ phase: "working", motion: "look_up" }), false),
    ).toMatchObject({ motion: "look_up", props: ["prop.binder"] });
  });

  it("ツールが終わったらうなずきを1回、再確認ではコンシェルジュがはんこを1回押す", () => {
    expect(staffPlan("scout", staff({ phase: "working", motion: "nod" }), false)).toMatchObject({
      motion: "nod",
      once: true,
      face: "happy",
    });
    expect(
      staffPlan("concierge", staff({ phase: "working", motion: "stamp" }), false),
    ).toMatchObject({ motion: "stamp", once: true, props: ["prop.stamp"] });
  });

  it("旅程ができたら、旅程係が書類を抱えてカウンターへ運ぶ", () => {
    expect(staffPlan("planner", staff({ phase: "working", motion: "carry" }), false)).toMatchObject(
      {
        spot: "drop",
        travel: "carry",
        props: ["prop.document"],
      },
    );
  });

  it("戻るときは待機位置へ歩き、コンシェルジュは返答を話す", () => {
    expect(staffPlan("scout", staff({ phase: "returning", motion: "walk" }), false)).toMatchObject({
      spot: "home",
      motion: "idle",
      travel: "walk",
    });
    expect(staffPlan("concierge", staff({ motion: "talk" }), false)).toMatchObject({
      spot: "home",
      motion: "talk",
      face: "happy",
    });
  });

  it("しおりの完成の演出では、コンシェルジュがはんこを押し、ほかの人は手を振る", () => {
    expect(staffPlan("concierge", IDLE_STAFF, true)).toMatchObject({
      motion: "stamp",
      face: "sparkle",
    });
    expect(staffPlan("planner", IDLE_STAFF, true)).toMatchObject({
      spot: "home",
      motion: "wave",
      face: "happy",
    });
  });
});

describe("旅人", () => {
  it("カウンターの前に立ち、しおりができたら1回喜ぶ", () => {
    expect(playerPlan(false, false)).toMatchObject({
      spot: "home",
      motion: "idle",
      face: "normal",
    });
    expect(playerPlan(false, true)).toMatchObject({ motion: "idle", face: "happy" });
    expect(playerPlan(true, false)).toMatchObject({ motion: "cheer", once: true, face: "sparkle" });
  });
});

describe("歩く", () => {
  it("目的地へ速さどおりに進み、行き過ぎない", () => {
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 0, y: 0, z: 2 };
    const step = walkStep(from, to, 1);
    expect(step.position.z).toBeCloseTo(WALK_SPEED);
    expect(step.arrived).toBe(false);
    expect(step.heading).toBeCloseTo(0);

    const last = walkStep({ x: 0, y: 0, z: 1.9 }, to, 1);
    expect(last).toMatchObject({ arrived: true, position: to });
  });

  it("進む向きは、キャラクターの正面（+Z）からの角度", () => {
    expect(walkStep({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.1).heading).toBeCloseTo(
      Math.PI / 2,
    );
  });

  it("向きを変えるときは、最短の向きに回る", () => {
    expect(turnToward(Math.PI - 0.1, -Math.PI + 0.1, 1)).toBeCloseTo(Math.PI + 0.1);
    expect(turnToward(0, 1, 0.5)).toBeCloseTo(0.5);
  });
});

describe("カメラ", () => {
  function frameHeightOf(view: { fov: number }, height: number): number {
    // 設計した枠の高さ（px）：tan(設計の画角/2) / tan(画面の画角/2) × 画面の高さ
    return (Math.tan(DESIGN_YFOV / 2) / Math.tan((view.fov * Math.PI) / 360)) * height;
  }

  it("重なるものがなければ、16:9 では設計どおりに映す", () => {
    const view = frameView(1600, 900, DESIGN_YFOV);
    expect(view.fov).toBeCloseTo((DESIGN_YFOV * 180) / Math.PI);
    expect(view).toMatchObject({ offsetX: 0, offsetY: 0 });
  });

  it("縦長の画面では横の画角を保ち、横長の画面では縦の画角を保つ（はみ出さない）", () => {
    expect(frameHeightOf(frameView(900, 1600, DESIGN_YFOV), 1600)).toBeCloseTo(900 / (16 / 9));
    expect(frameHeightOf(frameView(3000, 900, DESIGN_YFOV), 900)).toBeCloseTo(900);
  });

  it("cover では、枠で画面を埋める（はしは切れてよい）", () => {
    expect(frameHeightOf(frameView(3000, 900, DESIGN_YFOV, undefined, "cover"), 900)).toBeCloseTo(
      3000 / (16 / 9),
    );
    expect(frameHeightOf(frameView(900, 1600, DESIGN_YFOV, undefined, "cover"), 1600)).toBeCloseTo(
      1600,
    );
  });

  it("会話の窓とパネルを避けた場所に、枠を収めて寄せる", () => {
    const insets = { top: 60, right: 440, bottom: 220, left: 0 };
    const view = frameView(1440, 900, DESIGN_YFOV, insets);
    const freeWidth = 1440 - 440;
    const freeHeight = 900 - 60 - 220;
    expect(frameHeightOf(view, 900)).toBeCloseTo(Math.min(freeHeight, freeWidth / (16 / 9)));
    // 絵の中心は、空いている場所の中心に来る
    expect(1440 / 2 - view.offsetX).toBeCloseTo(freeWidth / 2);
    expect(900 / 2 - view.offsetY).toBeCloseTo(60 + freeHeight / 2);
  });

  it("入店のカメラが上がり始めたら外観を消す（2.25〜2.97 秒）", () => {
    expect(exteriorOpacity(0)).toBe(1);
    expect(exteriorOpacity(2.25)).toBe(1);
    expect(exteriorOpacity(2.61)).toBeCloseTo(0.5);
    expect(exteriorOpacity(3)).toBe(0);
  });
});

describe("旅程の提案が出たあとの動き", () => {
  it("作業中でも書類を運ぶ途中でも、待機位置に立ったまま動かない", () => {
    const calm = { calm: true };
    expect(
      staffPlan(
        "researcher",
        staff({ phase: "working", motion: "flip", task: "find_festivals" }),
        false,
        calm,
      ),
    ).toMatchObject({ spot: "home", motion: "idle", props: [] });
    expect(
      staffPlan("planner", staff({ phase: "working", motion: "carry" }), false, calm),
    ).toMatchObject({ spot: "home", motion: "idle", travel: "walk" });
    expect(staffPlan("concierge", staff({}), false, { ...calm, asking: true }).motion).toBe("idle");
  });

  it("コンシェルジュの話す仕草と、しおりの完成の演出は残す", () => {
    expect(staffPlan("concierge", staff({ motion: "talk" }), false, { calm: true }).motion).toBe(
      "talk",
    );
    expect(staffPlan("concierge", staff({}), true, { calm: true }).motion).toBe("stamp");
  });
});

describe("頼みと受け渡しの動き", () => {
  it("頼んでいる間、コンシェルジュは待機位置で相手を指す", () => {
    expect(staffPlan("concierge", staff({}), false, { asking: true })).toMatchObject({
      spot: "home",
      motion: "point",
    });
    // ほかのスタッフは頼む側にならない
    expect(staffPlan("scout", staff({}), false, { asking: true }).motion).toBe("idle");
  });

  it("相手の方を向く（正面は +Z）。同じ場所なら向きを変えない", () => {
    const at = { x: 0, y: 0, z: 0 };
    expect(facingYaw(at, { x: 0, y: 1, z: 2 })).toBeCloseTo(0);
    expect(facingYaw(at, { x: 1, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2);
    expect(facingYaw(at, { x: 0, y: 3, z: 0 })).toBeNull();
  });

  it("手紙は渡す人から受け取る人へ、山なりに渡る", () => {
    const from = { x: 0, y: 1, z: 0 };
    const to = { x: 2, y: 1, z: 0 };
    expect(letterPoint(from, to, 0)).toEqual(from);
    expect(letterPoint(from, to, 1)).toEqual(to);
    const middle = letterPoint(from, to, 0.5);
    expect(middle.x).toBeCloseTo(1);
    expect(middle.y).toBeCloseTo(1 + LETTER_ARC);
    // 範囲の外は端に止める
    expect(letterPoint(from, to, 2)).toEqual(to);
  });
});
