import { describe, expect, it } from "vitest";
import {
  clampOrbit,
  clockHands,
  followOffset,
  intentToWorld,
  isMoveKey,
  keepCameraInside,
  moveIntent,
  nearestTarget,
  type Target,
} from "./controls";

function target(id: string, x: number, z: number, interaction: Target["interaction"]): Target {
  return { id, interaction, stand: { x, z }, radius: 1, face: { x, z } };
}

describe("動かしたい向き", () => {
  it("WASD と矢印のキーを、画面の上の向きにする", () => {
    expect(moveIntent(new Set(["KeyW"]))).toEqual({ x: 0, y: 1 });
    expect(moveIntent(new Set(["ArrowLeft"]))).toEqual({ x: -1, y: 0 });
    expect(moveIntent(new Set(["KeyW", "KeyS"]))).toEqual({ x: 0, y: 0 });
  });

  it("斜めでも速くならない", () => {
    const intent = moveIntent(new Set(["KeyW", "KeyD"]));
    expect(Math.hypot(intent.x, intent.y)).toBeCloseTo(1);
  });

  it("スティックは遊びより小さい傾きを無視し、下が正の y を上向きに直す", () => {
    expect(moveIntent(new Set(), { x: 0.1, y: 0.1 })).toEqual({ x: 0, y: 0 });
    expect(moveIntent(new Set(), { x: 0, y: -0.8 }).y).toBeCloseTo(0.8);
  });

  it("動かすキーだけを拾う", () => {
    expect(isMoveKey("KeyA")).toBe(true);
    expect(isMoveKey("KeyE")).toBe(false);
  });

  it("カメラが奥（-Z）を向いているとき、上は奥、右は +X", () => {
    const forward = { x: 0, z: -1 };
    const up = intentToWorld({ x: 0, y: 1 }, forward);
    const right = intentToWorld({ x: 1, y: 0 }, forward);
    expect(up.x).toBeCloseTo(0);
    expect(up.z).toBeCloseTo(-1);
    expect(right.x).toBeCloseTo(1);
    expect(right.z).toBeCloseTo(0);
  });
});

describe("近くで使えるもの", () => {
  it("届く範囲のうち、いちばん近いものを選ぶ", () => {
    const targets = [
      target("bell", 0.5, 0, { kind: "gimmick", gimmick: "bell" }),
      target("sofa", 0.2, 0, { kind: "sit", seat: "seat.customer.sofa.1" }),
      target("far", 5, 0, { kind: "gimmick", gimmick: "gacha" }),
    ];
    expect(nearestTarget(targets, { x: 0, z: 0 })?.id).toBe("sofa");
    expect(nearestTarget(targets, { x: 9, z: 9 })).toBeNull();
  });

  it("スタッフと話すのは、少し遠くても先にする", () => {
    const targets = [
      target("bell", 0.2, 0, { kind: "gimmick", gimmick: "bell" }),
      target("concierge", 0.5, 0, { kind: "talk", staff: "concierge" }),
    ];
    expect(nearestTarget(targets, { x: 0, z: 0 })?.id).toBe("concierge");
  });
});

describe("時計とカメラ", () => {
  it("3時ちょうどは、短い針が 1/4 回り、長い針は 0", () => {
    const hands = clockHands(new Date(2026, 7, 16, 15, 0, 0));
    expect(hands.minute).toBeCloseTo(0);
    expect(hands.hour).toBeCloseTo(-Math.PI / 2);
  });

  it("カメラは旅人のずれに合わせて動き、行き過ぎない", () => {
    expect(followOffset({ x: 1, z: 1 }, { x: 0, z: 0 })).toEqual({ x: 0.7, z: 0.5 });
    const far = followOffset({ x: 100, z: 0 }, { x: 0, z: 0 }, { max: 2 });
    expect(far.x).toBeCloseTo(2);
  });
});

describe("カメラの操作", () => {
  it("回す・寄るのは、旅人を見失わない範囲に限る", () => {
    expect(clampOrbit({ yaw: 5, pitch: -5, zoom: 0.1 })).toEqual({
      yaw: 0.75,
      pitch: -0.3,
      zoom: 0.5,
    });
    expect(clampOrbit({ yaw: 0.2, pitch: 0.1, zoom: 1 })).toEqual({
      yaw: 0.2,
      pitch: 0.1,
      zoom: 1,
    });
  });

  it("壁より低いところでは、カメラを店の箱の内側に収め、床に潜らせない", () => {
    expect(keepCameraInside({ x: 6, y: 2, z: -5 })).toEqual({ x: 3.7, y: 2, z: -2.6 });
    expect(keepCameraInside({ x: 0, y: -1, z: 0 }).y).toBe(1.6);
  });

  it("壁より高いところと、開いている手前は抑えない", () => {
    expect(keepCameraInside({ x: 6, y: 6, z: -5 })).toEqual({ x: 6, y: 6, z: -5 });
    expect(keepCameraInside({ x: 0, y: 2, z: 9 })).toEqual({ x: 0, y: 2, z: 9 });
  });
});
