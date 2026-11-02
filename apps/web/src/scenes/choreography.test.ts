import { describe, expect, it } from "vitest";
import { IDLE_STAFF } from "../state/initial";
import type { StaffState } from "../state/types";
import {
  exteriorOpacity,
  fitVerticalFov,
  frameShift,
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
  it("16:9 では設計どおり、横長では縦の画角を保ち、縦長では横の画角を保つ", () => {
    const design = (DESIGN_YFOV * 180) / Math.PI;
    expect(fitVerticalFov(DESIGN_YFOV, 16 / 9)).toBeCloseTo(design);
    expect(fitVerticalFov(DESIGN_YFOV, 3)).toBeCloseTo(design);
    const horizontal = 2 * Math.atan(Math.tan(DESIGN_YFOV / 2) * (16 / 9));
    const portrait = fitVerticalFov(DESIGN_YFOV, 9 / 16);
    expect(2 * Math.atan(Math.tan((portrait * Math.PI) / 180 / 2) * (9 / 16))).toBeCloseTo(
      horizontal,
    );
  });

  it("入店のカメラが上がり始めたら外観を消す（2.25〜2.97 秒）", () => {
    expect(exteriorOpacity(0)).toBe(1);
    expect(exteriorOpacity(2.25)).toBe(1);
    expect(exteriorOpacity(2.61)).toBeCloseTo(0.5);
    expect(exteriorOpacity(3)).toBe(0);
  });

  it("横長の枠では、右の列に隠れないよう店を左へ寄せる。寄せすぎて左にはみ出さない", () => {
    expect(frameShift(16 / 9, 0.3)).toBe(0);
    expect(frameShift(3, 0)).toBe(0);
    const shift = frameShift(3.2, 0.3);
    expect(shift).toBeGreaterThan(0);
    const shop = 2.06 / 3.2;
    const center = 0.5 - shift / 2;
    expect(center + shop / 2).toBeCloseTo(0.7);
    expect(center - shop / 2).toBeGreaterThanOrEqual(0);
    // 店が枠いっぱいのときは、左端をそろえる（それ以上は寄せない）
    expect(0.5 - frameShift(2, 0.3) / 2).toBeCloseTo(Math.min(1, 2.06 / 2) / 2);
  });
});
