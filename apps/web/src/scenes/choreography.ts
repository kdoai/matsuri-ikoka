import type { StaffId } from "@matsuri-ikoka/schema";
import { type FrameInsets, NO_INSETS } from "../state/scene";
import type { StaffMotion, StaffState } from "../state/types";

// ストアのスタッフの状態から、3D の店内で「誰がどこで何をするか」を決める。
// 3D の部品はここで決めたとおりに動かすだけにする。three.js には依存しない。

/** 3D のモーションの名前（assets/3d/models/motion_<name>.glb） */
export const SCENE_MOTIONS = [
  "idle",
  "walk",
  "flip",
  "point",
  "look_up",
  "nod",
  "talk",
  "stamp",
  "carry",
  "wave",
  "sit",
  "cheer",
] as const;
export type SceneMotion = (typeof SCENE_MOTIONS)[number];

/** 表情（顔のテクスチャの 4 列 × 2 段の並び） */
export const FACES = {
  normal: [0, 0],
  blink: [1, 0],
  happy: [2, 0],
  surprised: [3, 0],
  wink: [0, 1],
  sleepy: [1, 1],
  sparkle: [2, 1],
  determined: [3, 1],
} as const satisfies Record<string, readonly [number, number]>;
export type Face = keyof typeof FACES;

/** スタッフが立つ場所：待機位置 / 持ち場 / カウンターの書類を置く位置 */
export type Spot = "home" | "post" | "drop";

/** スタッフの見た目（GLB のファイルと、役割の小物） */
export const STAFF_KIND: Record<StaffId, "hiyoko" | "owl" | "hen" | "sparrow"> = {
  concierge: "hiyoko",
  researcher: "owl",
  scout: "hen",
  planner: "sparrow",
};

export interface StaffPlan {
  spot: Spot;
  /** その場所に着いたら流すモーション（向かう途中は walk か carry） */
  motion: SceneMotion;
  /** 1回だけ流して待機に戻るか（うなずき・はんこ） */
  once: boolean;
  /** 向かう途中のモーション */
  travel: "walk" | "carry";
  face: Face;
  /** 見せる小物（ノードの名前 prop.*）。ほかの小物は隠す */
  props: string[];
}

/** 作業の動きと、そのとき手に持つ小物 */
const WORK_PROPS: Partial<Record<StaffMotion, string[]>> = {
  flip: ["prop.book"],
  point: ["prop.map"],
  look_up: ["prop.binder"],
  stamp: ["prop.stamp"],
  carry: ["prop.document"],
};

const ONCE: ReadonlySet<StaffMotion> = new Set(["nod", "stamp"]);

/**
 * スタッフ1人の段取り。
 * - 待機・戻る：待機位置へ。待機では idle（コンシェルジュが話しているときは talk）
 * - 持ち場へ移動・作業：持ち場へ。着いたら作業の動き（めくる・指す・見上げる・うなずく）
 * - 書類を運ぶ（carry）：旅程係がカウンターの書類を置く位置へ、書類を抱えて歩く
 * - しおりの完成の演出の間は、全員がにっこりして、コンシェルジュがはんこを押す
 */
export function staffPlan(id: StaffId, staff: StaffState, celebrating: boolean): StaffPlan {
  if (celebrating) {
    return id === "concierge"
      ? plan("home", "stamp", "sparkle", ["prop.stamp"], { once: true })
      : plan(staff.phase === "idle" ? "home" : spotOf(staff), "wave", "happy", []);
  }
  if (staff.motion === "carry") {
    return plan("drop", "nod", "happy", ["prop.document"], { travel: "carry" });
  }
  if (staff.phase === "idle" || staff.phase === "returning") {
    if (id === "concierge" && staff.motion === "talk") {
      return plan("home", "talk", "happy", []);
    }
    return plan("home", "idle", "normal", []);
  }
  // 持ち場へ移動・作業
  const motion = toSceneMotion(staff.motion);
  const face: Face = motion === "nod" ? "happy" : motion === "talk" ? "happy" : "determined";
  return plan("post", motion, face, WORK_PROPS[staff.motion] ?? [], {
    once: ONCE.has(staff.motion),
  });
}

/**
 * 旅人（利用者が動かすペンギン）の段取り。カウンターの前に立ち、
 * しおりができたら両手を上げて喜び、返事を待つ間はにこにこする。
 */
export function playerPlan(celebrating: boolean, talking: boolean): StaffPlan {
  if (celebrating) {
    return plan("home", "cheer", "sparkle", [], { once: true });
  }
  return plan("home", "idle", talking ? "happy" : "normal", []);
}

function spotOf(staff: StaffState): Spot {
  return staff.phase === "walking" || staff.phase === "working" ? "post" : "home";
}

function toSceneMotion(motion: StaffMotion): SceneMotion {
  // 持ち場に着いたあとは歩かない。移動の途中は travel で歩く
  return motion === "walk" ? "idle" : motion;
}

function plan(
  spot: Spot,
  motion: SceneMotion,
  face: Face,
  props: string[],
  options: { once?: boolean; travel?: "walk" | "carry" } = {},
): StaffPlan {
  return {
    spot,
    motion,
    once: options.once ?? false,
    travel: options.travel ?? "walk",
    face,
    props,
  };
}

// ---------------------------------------------------------------------------
// 移動とカメラの計算（three.js に依存しない、平面の上の計算）

export interface Point {
  x: number;
  y: number;
  z: number;
}

/** 歩く速さ（m/s）。walk のモーションに合う 0.4〜0.5 m/s */
export const WALK_SPEED = 0.45;
/** この距離より近ければ着いたことにする（m） */
export const ARRIVE_DISTANCE = 0.03;

export interface StepResult {
  position: Point;
  arrived: boolean;
  /** 進む向き（Y 軸まわり。キャラクターの正面は +Z）。着いたら null */
  heading: number | null;
}

/** 目的地へ dt 秒ぶん歩く。行き過ぎない */
export function walkStep(from: Point, to: Point, dt: number, speed = WALK_SPEED): StepResult {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= ARRIVE_DISTANCE) {
    return { position: { ...to }, arrived: true, heading: null };
  }
  const step = Math.min(distance, speed * dt);
  const ratio = step / distance;
  const arrived = distance - step <= ARRIVE_DISTANCE;
  return {
    position: arrived
      ? { ...to }
      : { x: from.x + dx * ratio, y: from.y + (to.y - from.y) * ratio, z: from.z + dz * ratio },
    arrived,
    heading: Math.atan2(dx, dz),
  };
}

/** 角度 a から b へ、最短の向きに t（0〜1）だけ回す */
export function turnToward(a: number, b: number, t: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * Math.min(1, Math.max(0, t));
}

/** 設計した画面比（cam.main・cam.entry は 16:9 で作ってある） */
export const DESIGN_ASPECT = 16 / 9;

export interface FrameView {
  /** 画面全体の縦の画角（度） */
  fov: number;
  /** 絵を寄せる量（px）。three.js の setViewOffset にそのまま渡す（正の値で左・上へ寄る） */
  offsetX: number;
  offsetY: number;
}

/**
 * カメラの映し方。設計した 16:9 の枠を、画面のうち会話の窓やパネルが重ならない場所に、
 * はみ出さずに収める（縦長なら横の画角を、横長なら縦の画角を保つことになる）。
 * カメラの位置と向きは変えず、画角と絵の寄せ方だけで合わせる。
 */
export function frameView(
  width: number,
  height: number,
  designYfov: number,
  insets: FrameInsets = NO_INSETS,
  fit: "contain" | "cover" = "contain",
): FrameView {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const freeWidth = Math.max(1, w - insets.left - insets.right);
  const freeHeight = Math.max(1, h - insets.top - insets.bottom);
  // contain：枠がはみ出さない / cover：枠で画面を埋める（ゲームの画面のように、はしは切れてよい）
  const frameHeight =
    fit === "contain"
      ? Math.min(freeHeight, freeWidth / DESIGN_ASPECT)
      : Math.max(freeHeight, freeWidth / DESIGN_ASPECT);
  const fov = 2 * Math.atan((Math.tan(designYfov / 2) * h) / frameHeight);
  const centerX = insets.left + freeWidth / 2;
  const centerY = insets.top + freeHeight / 2;
  return { fov: (fov * 180) / Math.PI, offsetX: w / 2 - centerX, offsetY: h / 2 - centerY };
}

/** 入店のカメラの経路で、外観を消し始めて消し終える時刻（秒）。経路の 50%〜66% */
export const ENTRY_FADE = { from: 2.25, to: 2.97 } as const;

/** 入店のカメラの時刻から、外観の不透明度を決める */
export function exteriorOpacity(time: number): number {
  if (time <= ENTRY_FADE.from) return 1;
  if (time >= ENTRY_FADE.to) return 0;
  return 1 - (time - ENTRY_FADE.from) / (ENTRY_FADE.to - ENTRY_FADE.from);
}
