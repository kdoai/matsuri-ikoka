import type { GuideSpot } from "../state/guide";
import type { Face, SceneMotion } from "./choreography";
import type { GuideMotion } from "./modelFiles";
import { createNavGrid, gridWalkable, type NavGrid, type NavMesh, type Walkable } from "./navmesh";

// 縁日の通りの決まりごと。three.js には依存しない。3D の部品は、ここで決めたとおりに動かすだけにする。

/**
 * 道を探す升目。屋台の間と休憩所の通路は幅 0.2 m のところがあり、体の余白を取るとふさがって
 * ベンチへの道がなくなる。歩ける床はすでに体の半径ぶん広げて抜いてあるので、余白は足さない
 */
export function streetGrid(nav: NavMesh): NavGrid {
  return createNavGrid(nav, 0.1, 0);
}

/**
 * 旅人がキーやスティックで立てるところ（3 cm の升目）。店内と同じ余白（0.12 m）では休憩所の通路が
 * ふさがるので、通路を残せるいちばん大きな余白にする
 */
export function streetWalkable(nav: NavMesh): Walkable {
  return gridWalkable(createNavGrid(nav, 0.03, 0.06));
}

/** ガイドが移るときの動きと速さ。run と lead は記録した歩幅より速く歩くので、モーションも速く流す */
export interface GuideTravel {
  motion: GuideMotion;
  /** m/s */
  speed: number;
  clipSpeed: number;
}

/** 旅人のそばへは駆け寄り、屋台と入り口へは旗を掲げて先導する */
export function guideTravel(spot: GuideSpot): GuideTravel {
  return spot === "player"
    ? { motion: "run", speed: 1.8, clipSpeed: 1.5 }
    : { motion: "lead", speed: 1.15, clipSpeed: 2.5 };
}

export interface GuideRest {
  motion: SceneMotion;
  face: Face;
}

/** 着いたあとの動き。屋台の脇では旗を振り、話している間は話す仕草をする */
export function guideRest(spot: GuideSpot, talking: boolean): GuideRest {
  if (talking) return { motion: "talk", face: "happy" };
  if (spot !== "home" && spot !== "player") return { motion: "wave_flag", face: "happy" };
  return { motion: "idle", face: spot === "player" ? "happy" : "normal" };
}

/** 旅人のそばへ来たときに空ける距離（m） */
export const GUIDE_NEAR_PLAYER = 0.85;

/** カメラが旅人の横の動きについていく割合 */
export const STREET_FOLLOW_SIDE = 0.8;
/**
 * 全景のカメラ（寄ったあと）の視線の先と、旅人の奥行きの差（m）を決める値。
 * 旅人を画面の下のほうに置き、進む先の屋台を見せる
 */
export const STREET_AHEAD = 9.5;
/** 通りの全景のカメラ（cam.ennichi）から、視線の向きに寄る距離（m） */
export const STREET_DOLLY = 3.4;

/** 会話の窓の高さのうち、この割合だけ通りの絵を持ち上げる（上げすぎると、空の上の背景が見える） */
export const STREET_LIFT = 0.7;

/**
 * 画面の比に合わせた縦の画角。縦長の画面では、同じ画角だと通りの幅が入らないので広げる。
 * 広げすぎると足もとが歪むので、比 0.6 までにする
 */
export function streetFov(baseYfov: number, aspect: number): number {
  return baseYfov / Math.max(0.6, Math.min(1, aspect));
}

/** カメラを全景の位置からずらす量。旅人がどこにいても、同じ見え方でついていく */
export function streetFollow(player: { x: number; z: number }): { x: number; z: number } {
  return { x: player.x * STREET_FOLLOW_SIDE, z: player.z - STREET_AHEAD };
}
