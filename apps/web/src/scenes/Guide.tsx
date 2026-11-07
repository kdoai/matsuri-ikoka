import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type Group,
  LoopRepeat,
  type Object3D,
  type Vector3,
} from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { GuideSpot } from "../state/guide";
import { FACES, turnToward } from "./choreography";
import { originalName } from "./models";
import { type FlatPoint, findPath, nearestOnNavMesh } from "./navmesh";
import { faceTexture, setFace } from "./Staff";
import { GUIDE_NEAR_PLAYER, guideRest, guideTravel } from "./streetPlan";
import type { StreetWorld } from "./streetWorld";

// 通りのガイド。店のコンシェルジュと同じひよこのモデルに、帽子と旗（prop.guide_*）を出す。
// どこに立つかはストア（guide.spot）が決める。ここはそのとおりに歩くだけで、状態を持たない。

const FADE_SECONDS = 0.2;
const ARRIVE = 0.08;
/** 旅人が動いたら、道を探し直す間隔（秒） */
const REPATH_SECONDS = 0.5;
/** 吹き出しの札を置く高さ（m）。旗の先より少し上 */
const HEAD_HEIGHT = 1.55;
const GUIDE_PROPS = ["prop.guide_cap", "prop.guide_flag"];

export interface GuideProps {
  model: GLTF;
  clips: Record<string, AnimationClip | undefined>;
  world: StreetWorld;
  spot: GuideSpot;
  talking: boolean;
  player: React.RefObject<Vector3>;
  onHead(x: number, y: number, z: number): void;
}

export function Guide({ model, clips, world, spot, talking, player, onHead }: GuideProps) {
  const group = useRef<Group>(null);
  const root = model.scene;
  const mixer = useMemo(() => new AnimationMixer(root), [root]);
  const face = useMemo(() => faceTexture(root, "hiyoko"), [root]);
  const marks = world.guideMarks;
  const state = useRef({
    // 店の入口から出てきて、通りの入り口へ先導する
    x: marks.door.x,
    z: marks.door.z,
    yaw: marks.door.yaw,
    path: [] as FlatPoint[],
    pathFor: null as string | null,
    repath: 0,
    current: null as AnimationAction | null,
    currentName: "",
  });

  // 帽子と旗を出し、はんこなどの小物は隠す
  useEffect(() => {
    const list: Object3D[] = [];
    root.traverse((object) => {
      if (originalName(object).startsWith("prop.")) list.push(object);
    });
    for (const prop of list) prop.visible = GUIDE_PROPS.includes(originalName(prop));
  }, [root]);

  useEffect(
    () => () => {
      mixer.stopAllAction();
    },
    [mixer],
  );

  const play = (name: string, timeScale: number) => {
    const s = state.current;
    const clip = clips[name] ?? clips.idle;
    if (clip === undefined) return;
    const action = mixer.clipAction(clip);
    action.timeScale = timeScale;
    if (s.currentName === name) return;
    action.reset();
    action.setLoop(LoopRepeat, Number.POSITIVE_INFINITY);
    if (s.current !== null && s.current !== action) {
      action.crossFadeFrom(s.current, FADE_SECONDS, false);
    }
    action.play();
    s.current = action;
    s.currentName = name;
  };

  /** いま向かう先 */
  const goal = (): FlatPoint => {
    if (spot !== "player") return marks[spot];
    const s = state.current;
    const at = player.current;
    const dx = s.x - at.x;
    const dz = s.z - at.z;
    const length = Math.hypot(dx, dz) || 1;
    return nearestOnNavMesh(
      world.nav,
      at.x + (dx / length) * GUIDE_NEAR_PLAYER,
      at.z + (dz / length) * GUIDE_NEAR_PLAYER,
    );
  };

  useFrame((_, delta) => {
    const object = group.current;
    if (object === null) return;
    const s = state.current;
    const dt = Math.min(delta, 0.1);

    // 旅人のそばにいて、旅人が離れなければ、歩き直さない
    const at = player.current;
    const stayNear =
      spot === "player" && Math.hypot(at.x - s.x, at.z - s.z) < GUIDE_NEAR_PLAYER + 0.35;
    s.repath -= dt;
    if (s.pathFor !== spot || (spot === "player" && !stayNear && s.repath <= 0)) {
      s.pathFor = spot;
      s.repath = REPATH_SECONDS;
      s.path = stayNear ? [] : findPath(world.grid, s, goal());
    }

    const point = s.path[0];
    const travel = guideTravel(spot);
    if (point !== undefined) {
      const dx = point.x - s.x;
      const dz = point.z - s.z;
      const distance = Math.hypot(dx, dz);
      if (distance <= ARRIVE) {
        s.path.shift();
      } else {
        const step = Math.min(distance, travel.speed * dt);
        s.x += (dx / distance) * step;
        s.z += (dz / distance) * step;
        s.yaw = turnToward(s.yaw, Math.atan2(dx, dz), dt * 10);
      }
      play(travel.motion, travel.clipSpeed);
      setFace(face, FACES.determined);
    } else {
      // 着いたら旅人のほうを向く
      s.yaw = turnToward(s.yaw, Math.atan2(at.x - s.x, at.z - s.z), dt * 5);
      const rest = guideRest(spot, talking);
      play(rest.motion, 1);
      setFace(face, FACES[rest.face]);
    }

    const y = world.groundY ?? 0;
    object.position.set(s.x, y, s.z);
    object.rotation.y = s.yaw;
    mixer.update(dt);
    onHead(s.x, y + HEAD_HEIGHT, s.z);
  });

  return (
    <group ref={group} userData={{ staffId: "concierge" }}>
      <primitive object={root} dispose={null} />
    </group>
  );
}
