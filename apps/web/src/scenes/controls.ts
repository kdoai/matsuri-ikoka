import type { StaffId } from "@matsuri-ikoka/schema";
import type { FlatPoint } from "./navmesh";

// 旅人を動かす入力と、近くで使えるもの（話す・仕掛け・座る・隠れひよこ）の決め方。
// three.js には依存しない。3D の部品は、ここで決めたとおりに動かすだけにする。

/** 店内の仕掛け（interior.glb の gimmick.<name>）。触ると一度だけ動く */
export const GIMMICKS = [
  "bell",
  "stamp",
  "omikuji",
  "gacha",
  "daruma",
  "cat",
  "board",
  "furin",
  "noren",
  "globe",
  "secret",
  "gate",
] as const;
export type Gimmick = (typeof GIMMICKS)[number];

/** 仕掛けを動かすアニメーション（board は動かず、貼り紙を読むだけ） */
export const GIMMICK_CLIPS: Record<Gimmick, string | null> = {
  bell: "gimmick.bell.ring",
  stamp: "gimmick.stamp.press",
  omikuji: "gimmick.omikuji.shake",
  gacha: "gimmick.gacha.turn",
  daruma: "gimmick.daruma.wobble",
  cat: "gimmick.cat.pet",
  board: null,
  furin: "gimmick.furin.ring",
  noren: "gimmick.noren.sway",
  globe: "gimmick.globe.spin",
  secret: "gimmick.secret.open",
  gate: "gimmick.gate.swing",
};

/** 仕掛けの近くで旅人が立つ目印（interact.<name>）。ないものは、仕掛けに近い床の上に立つ */
export const GIMMICK_STANDS: Partial<Record<Gimmick, string>> = {
  bell: "interact.bell",
  stamp: "interact.stamp",
  omikuji: "interact.omikuji",
  gacha: "interact.gacha",
  daruma: "interact.souvenir",
  cat: "interact.cat",
  board: "interact.quest_board",
};

/** 仕掛けの本体のノード */
export function gimmickNode(gimmick: Gimmick): string {
  return gimmick === "board" ? "interact.quest_board" : `gimmick.${gimmick}`;
}

export const CHICKS = [1, 2, 3] as const;
export type Chick = (typeof CHICKS)[number];

export type Interaction =
  | { kind: "talk"; staff: StaffId }
  | { kind: "gimmick"; gimmick: Gimmick }
  | { kind: "sit"; seat: string }
  | { kind: "chick"; chick: Chick }
  /** のれんをくぐって店の外へ出る */
  | { kind: "exit" };

export interface Target {
  /** 見分けるための名前（同じものが近くに居続けるかを比べる） */
  id: string;
  interaction: Interaction;
  /** 旅人が立つ位置（ここから radius の内側で使える） */
  stand: FlatPoint;
  radius: number;
  /** 使うときに向く位置（仕掛けの本体・座面・スタッフ） */
  face: FlatPoint;
}

/** スタッフと話せる距離（カウンター越し）。m */
export const TALK_RADIUS = 2;
/** 話すを、ほかのものより先にする量（m） */
const TALK_PRIORITY = 1.6;

/**
 * いま使えるもの。radius の内側にあるもののうち、いちばん近いもの。
 * 同じ距離なら、話す・仕掛け・座る・ひよこの順に先にする。
 */
export function nearestTarget(targets: readonly Target[], at: FlatPoint): Target | null {
  const order: Interaction["kind"][] = ["talk", "exit", "gimmick", "sit", "chick"];
  let best: Target | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const distance = Math.hypot(target.stand.x - at.x, target.stand.z - at.z);
    if (distance > target.radius) continue;
    // 話すを先にする。ほかのものは、その真上に立っているときだけ話すより先にする
    const score = distance - (target.interaction.kind === "talk" ? TALK_PRIORITY : 0);
    if (
      score < bestScore ||
      (score === bestScore &&
        best !== null &&
        order.indexOf(target.interaction.kind) < order.indexOf(best.interaction.kind))
    ) {
      best = target;
      bestScore = score;
    }
  }
  return best;
}

/** 画面の上での動かしたい向き。x は右が正、y は上（奥）が正。長さは 1 まで */
export interface Intent {
  x: number;
  y: number;
}

const KEY_DIRECTIONS: Record<string, Intent> = {
  KeyW: { x: 0, y: 1 },
  ArrowUp: { x: 0, y: 1 },
  KeyS: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: -1 },
  KeyA: { x: -1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  KeyD: { x: 1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

/** 動かすキー（KeyboardEvent.code）か */
export function isMoveKey(code: string): boolean {
  return code in KEY_DIRECTIONS;
}

/** スティックの遊び。これより小さい傾きは 0 とみなす */
export const STICK_DEADZONE = 0.2;

/**
 * 押しているキーと、ゲームパッドの左スティック・十字キーから、動かしたい向きを決める。
 * スティックの y は、ゲームパッドの決まりどおり下が正で受け取る。
 */
export function moveIntent(keys: ReadonlySet<string>, stick: Intent | null = null): Intent {
  let x = 0;
  let y = 0;
  for (const code of keys) {
    const direction = KEY_DIRECTIONS[code];
    if (direction !== undefined) {
      x += direction.x;
      y += direction.y;
    }
  }
  if (stick !== null && Math.hypot(stick.x, stick.y) > STICK_DEADZONE) {
    x += stick.x;
    y -= stick.y;
  }
  const length = Math.hypot(x, y);
  return length > 1 ? { x: x / length, y: y / length } : { x, y };
}

/**
 * 画面の上の向きを、床の上の向きに変える。カメラの向き（床に落とした前の向き）を基準に、
 * 画面の上がカメラの前、画面の右がカメラの右になる。
 */
export function intentToWorld(intent: Intent, forward: FlatPoint): FlatPoint {
  const length = Math.hypot(forward.x, forward.z) || 1;
  const fx = forward.x / length;
  const fz = forward.z / length;
  // カメラの右（前の向きを、上から見て時計回りに 90°）
  const rx = -fz;
  const rz = fx;
  return { x: rx * intent.x + fx * intent.y, z: rz * intent.x + fz * intent.y };
}

/** 本物の時刻に合わせた、時計の針の回転（ノードの local Z まわり。時計回りが負） */
export function clockHands(date: Date): { hour: number; minute: number } {
  const minutes = date.getMinutes() + date.getSeconds() / 60;
  return {
    minute: (-2 * Math.PI * minutes) / 60,
    hour: (-2 * Math.PI * ((date.getHours() % 12) + minutes / 60)) / 12,
  };
}

/**
 * カメラを旅人に合わせて動かす量。カウンターの前（基準の位置）からのずれに、
 * 横と奥行きで別の割合を掛け、行き過ぎないように抑える。
 */
export function followOffset(
  player: FlatPoint,
  base: FlatPoint,
  options: { side?: number; depth?: number; max?: number } = {},
): FlatPoint {
  const { side = 0.7, depth = 0.5, max = 2.2 } = options;
  const x = (player.x - base.x) * side;
  const z = (player.z - base.z) * depth;
  const length = Math.hypot(x, z);
  return length > max ? { x: (x / length) * max, z: (z / length) * max } : { x, z };
}

// ---------------------------------------------------------------------------
// カメラの操作（マウスのドラッグ・ホイール、2本指、ゲームパッドの右スティック、キーボード）

/** 旅人のまわりを回す角度（ラジアン）と、寄る割合。0・0・1 がいつもの見え方 */
export interface Orbit {
  yaw: number;
  pitch: number;
  zoom: number;
}

export const DEFAULT_ORBIT: Orbit = Object.freeze({ yaw: 0, pitch: 0, zoom: 1 });

/**
 * 回せる範囲。店は手前（+Z）が開いた箱なので、横は手前の側から見える範囲だけ、
 * 縦は床に潜らず真上にもならない範囲、寄りは旅人を見失わない範囲に限る
 */
export const ORBIT_LIMITS = {
  yaw: 0.75,
  pitchMin: -0.3,
  pitchMax: 0.35,
  zoomMin: 0.5,
  zoomMax: 1.35,
} as const;

export function clampOrbit(orbit: Orbit): Orbit {
  return {
    yaw: Math.min(ORBIT_LIMITS.yaw, Math.max(-ORBIT_LIMITS.yaw, orbit.yaw)),
    pitch: Math.min(ORBIT_LIMITS.pitchMax, Math.max(ORBIT_LIMITS.pitchMin, orbit.pitch)),
    zoom: Math.min(ORBIT_LIMITS.zoomMax, Math.max(ORBIT_LIMITS.zoomMin, orbit.zoom)),
  };
}

/** カメラを回すキー（KeyboardEvent.code）と、そのときの向き */
export const CAMERA_KEYS: Record<string, Partial<Orbit>> = {
  KeyQ: { yaw: 1 },
  KeyR: { yaw: -1 },
  KeyZ: { zoom: -1 },
  KeyC: { zoom: 1 },
};

/** カメラをいつもの見え方に戻すキー */
export const CAMERA_RESET_KEY = "KeyV";

/** 店の箱（m）。壁の高さより低いところでは、カメラをこの内側に収める */
export const ROOM = { minX: -3.7, maxX: 3.7, minZ: -2.6, wallTop: 3.2, minY: 1.6 } as const;

/**
 * カメラの位置が壁や床の中に入らないように抑える。壁より高いところは、店の箱の上から
 * のぞくので抑えない。手前（+Z）は開いているので抑えない
 */
export function keepCameraInside(position: { x: number; y: number; z: number }): {
  x: number;
  y: number;
  z: number;
} {
  const y = Math.max(ROOM.minY, position.y);
  if (y >= ROOM.wallTop) return { x: position.x, y, z: position.z };
  return {
    x: Math.min(ROOM.maxX, Math.max(ROOM.minX, position.x)),
    y,
    z: Math.max(ROOM.minZ, position.z),
  };
}
