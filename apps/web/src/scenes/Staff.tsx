import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type Group,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Texture,
} from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import {
  FACES,
  type SceneMotion,
  type Spot,
  type StaffPlan,
  turnToward,
  walkStep,
} from "./choreography";
import { findNode, originalName } from "./models";

// スタッフ1人。段取り（choreography.ts の StaffPlan）のとおりに、目印の間を歩き、モーションを流す。
// キャラクターは骨に固定した硬い部品でできているので、一番上のノードを動かし、骨は動かさない。

export interface Mark {
  x: number;
  y: number;
  z: number;
  /** そこで向く方向（Y 軸まわり） */
  yaw: number;
}

const FADE_SECONDS = 0.25;
/** まばたきの間隔（秒）と長さ */
const BLINK_EVERY = [2.5, 5] as const;
const BLINK_LENGTH = 0.12;

function faceTexture(root: Object3D, kind: string): Texture | null {
  const face = findNode(root, `${kind}.face`);
  let texture: Texture | null = null;
  face?.traverse((object) => {
    if (texture === null && object instanceof Mesh) {
      const material = object.material;
      if (material instanceof MeshStandardMaterial && material.map !== null) {
        texture = material.map;
      }
    }
  });
  return texture;
}

function setFace(texture: Texture | null, cell: readonly [number, number]): void {
  texture?.offset.set(cell[0] * 0.25, cell[1] * 0.5);
}

export interface StaffProps {
  kind: string;
  model: GLTF;
  clips: Record<SceneMotion, AnimationClip | undefined>;
  marks: Record<Spot, Mark>;
  plan: StaffPlan;
  /** ストアの seq。変わったら1回きりの動きを出し直す */
  seq: number;
  /** 吹き出しを重ねる位置（頭の上）を、毎フレーム書き込む */
  onHead?: (x: number, y: number, z: number) => void;
}

export function Staff({ kind, model, clips, marks, plan, seq, onHead }: StaffProps) {
  const group = useRef<Group>(null);
  const root = model.scene;
  const mixer = useMemo(() => new AnimationMixer(root), [root]);
  const face = useMemo(() => faceTexture(root, kind), [root, kind]);
  const props = useMemo(() => {
    const list: Object3D[] = [];
    root.traverse((object) => {
      if (originalName(object).startsWith("prop.")) list.push(object);
    });
    return list;
  }, [root]);

  const state = useRef({
    started: false,
    yaw: marks.home.yaw,
    current: null as AnimationAction | null,
    currentName: "" as string,
    onceSeq: -1,
    onceDone: true,
    blinkIn: BLINK_EVERY[0] as number,
    blinkLeft: 0,
  });

  // 小物は必要な動作のときだけ見せる。表情も段取りに合わせる
  useEffect(() => {
    for (const prop of props) {
      prop.visible = plan.props.includes(originalName(prop));
    }
    setFace(face, FACES[plan.face]);
  }, [props, plan.props, plan.face, face]);

  // 1回きりの動きは、seq が変わるたびに出し直す
  useEffect(() => {
    const s = state.current;
    if (plan.once && s.onceSeq !== seq) {
      s.onceSeq = seq;
      s.onceDone = false;
    }
  }, [plan.once, seq]);

  useEffect(() => {
    const onFinished = () => {
      state.current.onceDone = true;
    };
    mixer.addEventListener("finished", onFinished);
    return () => {
      mixer.removeEventListener("finished", onFinished);
      mixer.stopAllAction();
    };
  }, [mixer]);

  const play = (name: SceneMotion, once: boolean) => {
    const s = state.current;
    const clip = clips[name] ?? clips.idle;
    if (clip === undefined) return;
    const key = `${name}${once ? `#${s.onceSeq}` : ""}`;
    if (s.currentName === key) return;
    const next = mixer.clipAction(clip);
    next.reset();
    next.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Number.POSITIVE_INFINITY);
    next.clampWhenFinished = once;
    next.enabled = true;
    if (s.current !== null && s.current !== next) {
      next.crossFadeFrom(s.current, FADE_SECONDS, false);
    }
    next.play();
    s.current = next;
    s.currentName = key;
  };

  useFrame((_, delta) => {
    const object = group.current;
    if (object === null) return;
    const s = state.current;
    const dt = Math.min(delta, 0.1);
    const target = marks[plan.spot];
    if (!s.started) {
      object.position.set(target.x, target.y, target.z);
      s.yaw = target.yaw;
      s.started = true;
    }

    const step = walkStep(object.position, target, dt);
    object.position.set(step.position.x, step.position.y, step.position.z);
    if (step.heading !== null && !step.arrived) {
      s.yaw = turnToward(s.yaw, step.heading, dt * 8);
      play(plan.travel, false);
    } else {
      s.yaw = turnToward(s.yaw, target.yaw, dt * 5);
      if (plan.once && !s.onceDone) {
        play(plan.motion, true);
      } else {
        play(plan.once ? "idle" : plan.motion, false);
      }
    }
    object.rotation.y = s.yaw;
    mixer.update(dt);

    // まばたき（ふつうの顔のときだけ）
    if (plan.face === "normal" && face !== null) {
      s.blinkIn -= dt;
      if (s.blinkIn <= 0) {
        s.blinkLeft = BLINK_LENGTH;
        s.blinkIn = BLINK_EVERY[0] + Math.random() * (BLINK_EVERY[1] - BLINK_EVERY[0]);
      }
      if (s.blinkLeft > 0) {
        s.blinkLeft -= dt;
        setFace(face, s.blinkLeft > 0 ? FACES.blink : FACES.normal);
      }
    }

    onHead?.(object.position.x, object.position.y + 1.25, object.position.z);
  });

  return (
    <group ref={group}>
      <primitive object={root} dispose={null} />
    </group>
  );
}
