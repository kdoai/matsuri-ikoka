import type { StaffId } from "@matsuri-ikoka/schema";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type Group,
  LoopOnce,
  LoopRepeat,
  type Object3D,
  Vector3,
} from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { playStore } from "../state/play";
import { FACES, type Face, type SceneMotion, turnToward } from "./choreography";
import {
  type Intent,
  type Interaction,
  intentToWorld,
  isMoveKey,
  moveIntent,
  nearestTarget,
  TALK_RADIUS,
  type Target,
} from "./controls";
import { originalName } from "./models";
import { type FlatPoint, findPath, slideMove } from "./navmesh";
import { faceTexture, setFace } from "./Staff";
import type { ShopWorld } from "./world";

// 旅人のペンギン。キーボード（WASD・矢印）・ゲームパッド・タップで動かし、歩ける床から出さない。
// 近くのスタッフに話しかけ、仕掛けを使い、座り、隠れひよこを見つける。
// 近くで使えるものと結果は playStore に書き、HUD が文字で出す。

/** 歩く速さ（m/s）。walk のモーション（0.45 m/s）を、この速さに合わせて速く流す */
const SPEED = 1.15;
const WALK_CLIP_SPEED = 0.45;
const FADE_SECONDS = 0.2;
/** 目的地に着いたとみなす距離（m） */
const ARRIVE = 0.06;

export type PadCommand = "details" | "map" | "menu";

export interface PlayerApi {
  /** 床の上の点へ歩く。着いたら then を使う */
  walkTo(point: FlatPoint, then?: Target | null): void;
  /** その場で使う（タップした仕掛け・ひよこ） */
  use(target: Target): void;
}

export interface PlayerProps {
  model: GLTF;
  clips: Record<SceneMotion, AnimationClip | undefined>;
  world: ShopWorld;
  /** スタッフの頭の上の位置（話せる距離を測る） */
  staff: React.RefObject<Record<StaffId, Vector3>>;
  celebrating: boolean;
  talking: boolean;
  /** 旅人の位置を毎フレーム書き込む（カメラと入口の壁に使う） */
  position: React.RefObject<Vector3>;
  api: React.Ref<PlayerApi>;
  onHead(x: number, y: number, z: number): void;
  onTalk(staff: StaffId): void;
  onGimmick(interaction: Interaction): void;
  onPad?(command: PadCommand): void;
}

/** 文字を入力しているときや、矢印キーで選ぶ部品（タブ・ラジオ）の上では、キーを旅人の操作にしない */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      "input, textarea, select, [contenteditable='true'], [role='tablist'], [role='radiogroup'], [role='listbox'], [role='menu'], [role='dialog']",
    ) !== null
  );
}

const PAD_BUTTONS: Partial<Record<number, "use" | PadCommand>> = {
  0: "use",
  2: "details",
  3: "map",
  9: "menu",
};

export function Player(props: PlayerProps) {
  const { model, clips, world, celebrating, talking } = props;
  const group = useRef<Group>(null);
  const root = model.scene;
  const camera = useThree((state) => state.camera);
  const mixer = useMemo(() => new AnimationMixer(root), [root]);
  const face = useMemo(() => faceTexture(root, "penguin"), [root]);
  const propsOf = useMemo(() => {
    const list: Object3D[] = [];
    root.traverse((object) => {
      if (originalName(object).startsWith("prop.")) list.push(object);
    });
    return list;
  }, [root]);
  const callbacks = useRef(props);
  callbacks.current = props;

  const s = useRef({
    x: world.start.x,
    z: world.start.z,
    y: 0,
    yaw: world.start.yaw,
    keys: new Set<string>(),
    goal: null as { path: FlatPoint[]; then: Target | null; stuck: number } | null,
    seat: null as string | null,
    once: null as { name: SceneMotion; left: number } | null,
    face: "normal" as Face,
    current: null as AnimationAction | null,
    currentName: "",
    nearId: null as string | null,
    near: null as Target | null,
    interactSeq: playStore.getState().interactSeq,
    padPressed: new Set<number>(),
    celebrated: false,
    blinkIn: 3,
    blinkLeft: 0,
  });

  // 小物は使わない
  useEffect(() => {
    for (const prop of propsOf) prop.visible = false;
  }, [propsOf]);

  useEffect(() => {
    playStore.getState().setActive(true);
    return () => {
      playStore.getState().setActive(false);
      mixer.stopAllAction();
    };
  }, [mixer]);

  // キーボード：押している動かすキーを覚える。入力欄の中では何もしない
  useEffect(() => {
    const keys = s.current.keys;
    const onDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      if (!isMoveKey(event.code)) return;
      keys.add(event.code);
      // 矢印キーでページが動かないようにする（ボタンの上でも旅人を動かす）
      event.preventDefault();
    };
    const onUp = (event: KeyboardEvent) => {
      keys.delete(event.code);
    };
    const clear = () => keys.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
    };
  }, []);

  const play = (name: SceneMotion, once = false, timeScale = 1) => {
    const state = s.current;
    const clip = clips[name] ?? clips.idle;
    if (clip === undefined) return;
    const action = mixer.clipAction(clip);
    action.timeScale = timeScale;
    if (state.currentName === name && !once) return;
    action.reset();
    action.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Number.POSITIVE_INFINITY);
    action.clampWhenFinished = once;
    if (state.current !== null && state.current !== action) {
      action.crossFadeFrom(state.current, FADE_SECONDS, false);
    }
    action.play();
    state.current = action;
    state.currentName = name;
  };

  const doOnce = (name: SceneMotion, face: Face) => {
    const clip = clips[name];
    s.current.once = { name, left: clip?.duration ?? 2 };
    s.current.face = face;
    play(name, true);
  };

  const standUp = () => {
    const state = s.current;
    if (state.seat === null) return;
    state.seat = null;
    state.y = 0;
    playStore.getState().setSitting(false);
  };

  const use = (target: Target) => {
    const state = s.current;
    const { interaction } = target;
    state.goal = null;
    state.yaw = Math.atan2(target.face.x - state.x, target.face.z - state.z);
    const store = playStore.getState();
    switch (interaction.kind) {
      case "talk":
        callbacks.current.onTalk(interaction.staff);
        break;
      case "sit": {
        const seat = world.seats[interaction.seat];
        if (seat === undefined) break;
        state.seat = interaction.seat;
        state.x = seat.x;
        state.z = seat.z;
        state.y = seat.y;
        state.yaw = seat.yaw;
        store.setSitting(true);
        break;
      }
      case "chick": {
        const first = store.findChick(interaction.chick);
        const found = playStore.getState().chicks.length;
        store.notify(found >= 3 && first ? { kind: "allChicks" } : { kind: "chick", found });
        doOnce("cheer", "sparkle");
        break;
      }
      case "gimmick":
        callbacks.current.onGimmick(interaction);
        doOnce("reach", "happy");
        break;
    }
  };

  /** その場所から使えるか（届く距離か） */
  const within = (target: Target) =>
    Math.hypot(target.stand.x - s.current.x, target.stand.z - s.current.z) <= target.radius + 0.05;

  useImperativeHandle(props.api, () => ({
    walkTo(point, then = null) {
      standUp();
      const path = findPath(world.grid, s.current, point);
      s.current.goal = path.length === 0 ? null : { path, then, stuck: 0 };
      // 道がなくても、すでに届くところにいれば使う
      if (path.length === 0 && then !== null && within(then)) use(then);
      playStore.getState().markMoved();
    },
    use,
  }));

  /** スタッフと話せる位置。毎フレーム、スタッフのいまの位置から作る */
  const staffTargets = (): Target[] => {
    const heads = callbacks.current.staff.current;
    if (heads === null) return [];
    return (Object.entries(heads) as [StaffId, Vector3][]).map(([id, head]) => ({
      id: `staff.${id}`,
      interaction: { kind: "talk", staff: id },
      stand: { x: head.x, z: head.z },
      radius: TALK_RADIUS,
      face: { x: head.x, z: head.z },
    }));
  };

  const forward = useMemo(() => new Vector3(), []);

  useFrame((_, delta) => {
    const object = group.current;
    if (object === null) return;
    const state = s.current;
    const dt = Math.min(delta, 0.1);
    const store = playStore.getState();

    // ゲームパッド
    let stick: Intent | null = null;
    let padUse = false;
    const pad = typeof navigator.getGamepads === "function" ? navigator.getGamepads()[0] : null;
    if (pad) {
      stick = { x: pad.axes[0] ?? 0, y: pad.axes[1] ?? 0 };
      const dpad = {
        x: (pad.buttons[15]?.pressed ? 1 : 0) - (pad.buttons[14]?.pressed ? 1 : 0),
        y: (pad.buttons[13]?.pressed ? 1 : 0) - (pad.buttons[12]?.pressed ? 1 : 0),
      };
      if (dpad.x !== 0 || dpad.y !== 0) stick = dpad;
      for (const [index, command] of Object.entries(PAD_BUTTONS)) {
        const button = Number(index);
        const pressed = pad.buttons[button]?.pressed === true;
        const was = state.padPressed.has(button);
        if (pressed && !was) {
          state.padPressed.add(button);
          if (command === "use") padUse = true;
          else if (command !== undefined) callbacks.current.onPad?.(command);
        } else if (!pressed && was) {
          state.padPressed.delete(button);
        }
      }
    }

    // 動かす
    const intent = moveIntent(state.keys, stick);
    const magnitude = Math.hypot(intent.x, intent.y);
    let speed = 0;
    if (magnitude > 0.05) {
      standUp();
      state.goal = null;
      state.once = null;
      camera.getWorldDirection(forward);
      const direction = intentToWorld(intent, { x: forward.x, z: forward.z });
      const step = SPEED * magnitude * dt;
      const next = slideMove(world.nav, state, direction.x * step, direction.z * step);
      speed = Math.hypot(next.x - state.x, next.z - state.z) / Math.max(dt, 1e-3);
      state.x = next.x;
      state.z = next.z;
      state.yaw = turnToward(state.yaw, Math.atan2(direction.x, direction.z), dt * 12);
      store.markMoved();
    } else if (state.goal !== null) {
      const point = state.goal.path[0] ?? state;
      const dx = point.x - state.x;
      const dz = point.z - state.z;
      const distance = Math.hypot(dx, dz);
      if (distance <= ARRIVE) {
        state.goal.path.shift();
        if (state.goal.path.length === 0) {
          const then = state.goal.then;
          state.goal = null;
          if (then !== null && within(then)) use(then);
        }
      } else {
        const step = Math.min(distance, SPEED * dt);
        const next = slideMove(world.nav, state, (dx / distance) * step, (dz / distance) * step);
        const moved = Math.hypot(next.x - state.x, next.z - state.z);
        speed = moved / Math.max(dt, 1e-3);
        state.x = next.x;
        state.z = next.z;
        state.yaw = turnToward(state.yaw, Math.atan2(dx, dz), dt * 10);
        // 家具に引っかかったら、そこで止まる（近ければ、そのまま使う）
        state.goal.stuck = moved < step * 0.2 ? state.goal.stuck + dt : 0;
        if (state.goal.stuck > 0.4) {
          const then = state.goal.then;
          state.goal = null;
          if (then !== null && within(then)) use(then);
        }
      }
    }

    // 近くで使えるもの
    const near =
      state.seat === null && speed === 0
        ? nearestTarget([...staffTargets(), ...world.targets], state)
        : state.seat === null
          ? state.near
          : null;
    if ((near?.id ?? null) !== state.nearId) {
      state.nearId = near?.id ?? null;
      state.near = near;
      store.setNear(near?.interaction ?? null);
    }

    // 使う（キーボードの E・HUD の「使う」・ゲームパッドの A）
    if (store.interactSeq !== state.interactSeq || padUse) {
      state.interactSeq = store.interactSeq;
      if (state.seat !== null) standUp();
      else if (state.near !== null) use(state.near);
      // 近くに何もなければ、窓口のコンシェルジュに話しかける（会話の窓の入力欄へ）
      else callbacks.current.onTalk("concierge");
    }

    // しおりができたら、両手を上げて喜ぶ（1回だけ）
    if (celebrating && !state.celebrated) {
      state.celebrated = true;
      doOnce("cheer", "sparkle");
    } else if (!celebrating) {
      state.celebrated = false;
    }

    // モーションと表情
    if (state.once !== null) {
      state.once.left -= dt;
      if (state.once.left <= 0) state.once = null;
    }
    if (state.once === null) {
      if (state.seat !== null) play("sit");
      else if (speed > 0.05) play("walk", false, Math.max(1, speed / WALK_CLIP_SPEED));
      else play("idle");
      state.face = talking ? "happy" : "normal";
    }
    const walk = clips.walk === undefined ? null : mixer.existingAction(clips.walk);
    if (walk !== null && speed > 0.05) walk.timeScale = Math.max(1, speed / WALK_CLIP_SPEED);

    object.position.set(state.x, state.y, state.z);
    object.rotation.y = state.yaw;
    mixer.update(dt);

    // 表情とまばたき
    if (state.face === "normal" && face !== null) {
      state.blinkIn -= dt;
      if (state.blinkIn <= 0) {
        state.blinkLeft = 0.12;
        state.blinkIn = 2.5 + Math.random() * 2.5;
      }
      if (state.blinkLeft > 0) state.blinkLeft -= dt;
      setFace(face, state.blinkLeft > 0 ? FACES.blink : FACES.normal);
    } else {
      setFace(face, FACES[state.face]);
    }

    props.position.current?.set(state.x, state.y, state.z);
    callbacks.current.onHead(state.x, state.y + 1.25, state.z);
  });

  return (
    <group ref={group}>
      <primitive object={root} dispose={null} />
      {/* 足もとの輪（いま動かせるキャラクターの目印） */}
      <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.32, 0.4, 40]} />
        <meshBasicMaterial color="#fff1c2" transparent opacity={0.85} toneMapped={false} />
      </mesh>
    </group>
  );
}
