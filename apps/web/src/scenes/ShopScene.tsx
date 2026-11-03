import { STAFF_IDS, type StaffId } from "@matsuri-ikoka/schema";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AnimationMixer, LoopRepeat, type PerspectiveCamera, Quaternion, Vector3 } from "three";
import { NO_INSETS, type ShopSceneProps } from "../state/scene";
import type { StaffState } from "../state/types";
import {
  exteriorOpacity,
  playerPlan,
  SCENE_MOTIONS,
  type SceneMotion,
  type Spot,
  STAFF_KIND,
  staffPlan,
} from "./choreography";
import { markEntryPlayed, shouldPlayEntry } from "./entry";
import { clipNamed, findNode, type ModelName, useModels, useSetModels } from "./models";
import { type Mark, Staff } from "./Staff";
import {
  applyPose,
  type CameraPose,
  cameraPose,
  Lights,
  prepareSet,
  setOpacity,
  useEntryRig,
  useRenderer,
} from "./stage";

// 3D の店内。ストアの状態（ShopSceneProps）を読むだけで、SSE のイベントは受けない。
// 吹き出しは 3D の上に HTML で重ねる（文字はストアのものをそのまま出す）。
// 同じ情報は、画面の 2D の部品（店内のようす・会話の窓・会話の記録）でも文字で読める。

const MOTION_MODELS = SCENE_MOTIONS.map((name) => `motion_${name}` as ModelName);
const STAFF_MODELS = STAFF_IDS.map((id) => `staff_${STAFF_KIND[id]}` as ModelName);

/** 吹き出しを出すか（作業に向かう・作業中のときだけ）。2D の見取り図と同じ決まり */
function showsBubble(staff: StaffState): boolean {
  return staff.bubble !== null && (staff.phase === "walking" || staff.phase === "working");
}

/** 頭の上の位置。スタッフ4人と旅人 */
type HeadPositions = Record<StaffId | "player", Vector3>;

/** 客の目線のカメラ：cam.main（店の全体）から cam.shiori（カウンターに寄る）へ、この割合だけ寄せる */
const GAME_VIEW = 0.72;

/** 会話の窓の高さのうち、この割合だけ店の絵を持ち上げて、カウンターの前の旅人を窓の上に出す */
const DIALOGUE_LIFT = 0.65;

function blendPose(from: CameraPose, to: CameraPose, t: number): CameraPose {
  return {
    position: from.position.clone().lerp(to.position, t),
    quaternion: from.quaternion.clone().slerp(to.quaternion, t),
    yfov: from.yfov + (to.yfov - from.yfov) * t,
  };
}

function markOf(root: import("three").Object3D, name: string): Mark | null {
  const node = findNode(root, name);
  if (node === undefined) return null;
  const position = new Vector3();
  const quaternion = new Quaternion();
  node.getWorldPosition(position);
  node.getWorldQuaternion(quaternion);
  // 目印の向き（Y 軸まわり）。キャラクターの正面は +Z
  const forward = new Vector3(0, 0, 1).applyQuaternion(quaternion);
  return { x: position.x, y: position.y, z: position.z, yaw: Math.atan2(forward.x, forward.z) };
}

function Shop({
  props,
  heads,
  onReady,
}: {
  props: ShopSceneProps;
  heads: React.RefObject<HeadPositions>;
  onReady: () => void;
}) {
  useRenderer();
  const { interior, exterior } = useSetModels();
  const staffModels = useModels(STAFF_MODELS);
  const [playerModel] = useModels(["player_penguin"]);
  const motionModels = useModels(MOTION_MODELS);
  const { camera, size } = useThree();

  const clips = useMemo(() => {
    const entries = SCENE_MOTIONS.map((name, index) => {
      const model = motionModels[index];
      return [name, model === undefined ? undefined : clipNamed(model, name)] as const;
    });
    return Object.fromEntries(entries) as Record<
      SceneMotion,
      import("three").AnimationClip | undefined
    >;
  }, [motionModels]);

  // 店内と外観を整え、目印（持ち場・待機位置・カウンター）とカメラを読む
  const set = useMemo(() => {
    prepareSet(interior.scene);
    prepareSet(exterior.scene);
    interior.scene.updateMatrixWorld(true);
    const marks = Object.fromEntries(
      STAFF_IDS.map((id) => {
        const home = markOf(interior.scene, `anchor.${id}.home`);
        const post = markOf(interior.scene, `anchor.${id}.post`) ?? home;
        const drop = markOf(interior.scene, "anchor.counter.drop");
        const concierge = markOf(interior.scene, "anchor.concierge.home");
        // 書類を置く位置はカウンターの上なので、その裏（コンシェルジュと同じ奥行き）に立つ
        const dropStand: Mark | null =
          drop === null
            ? null
            : { x: drop.x, y: 0, z: concierge === null ? drop.z - 0.5 : concierge.z, yaw: 0 };
        const fallback: Mark = { x: 0, y: 0, z: 0, yaw: 0 };
        return [
          id,
          {
            home: home ?? fallback,
            post: post ?? fallback,
            drop: dropStand ?? post ?? fallback,
          } satisfies Record<Spot, Mark>,
        ];
      }),
    ) as Record<StaffId, Record<Spot, Mark>>;
    const main = cameraPose(interior.scene, "cam.main");
    const shiori = cameraPose(interior.scene, "cam.shiori");
    const counter = markOf(interior.scene, "anchor.player.counter") ?? {
      x: 0.35,
      y: 0,
      z: 1.78,
      yaw: Math.PI,
    };
    return {
      marks,
      player: { home: counter, post: counter, drop: counter } satisfies Record<Spot, Mark>,
      main,
      shiori,
      game: main !== null && shiori !== null ? blendPose(main, shiori, GAME_VIEW) : main,
    };
  }, [interior, exterior]);

  // 寝ている猫はいつも寝息を立てる
  const gimmicks = useMemo(() => {
    const mixer = new AnimationMixer(interior.scene);
    const sleep = clipNamed(interior, "gimmick.cat.sleep");
    if (sleep !== undefined) mixer.clipAction(sleep).setLoop(LoopRepeat, Infinity).play();
    return mixer;
  }, [interior]);

  // 入店のカメラ：外観から店内へ入り、cam.main と同じ姿勢で止まる。1回だけ流す
  const entry = useEntryRig(exterior);
  const entering = useRef(entry !== null && shouldPlayEntry());
  const entryTime = useRef(entry?.start ?? 0);
  const pose = useRef<CameraPose | null>(null);
  const lift = useRef(entering.current ? 0 : props.frame.bottom * DIALOGUE_LIFT);

  useEffect(() => {
    if (!entering.current) {
      setOpacity(exterior.scene, 0);
    }
  }, [exterior]);

  const readied = useRef(false);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const perspective = camera as PerspectiveCamera;
    gimmicks.update(dt);

    if (entering.current && entry !== null) {
      entryTime.current = Math.min(entry.clip.duration, entryTime.current + dt);
      entry.mixer.setTime(entryTime.current);
      const at = cameraPose(exterior.scene, "cam.entry");
      if (at !== null) applyPose(perspective, at, size.width, size.height, NO_INSETS, "cover");
      setOpacity(exterior.scene, exteriorOpacity(entryTime.current));
      if (entryTime.current >= entry.clip.duration) {
        entering.current = false;
        markEntryPlayed();
        setOpacity(exterior.scene, 0);
      }
    } else if (set.game !== null) {
      // 入店のあとは客の目線へ寄り、しおりの完成の演出の間だけ、さらにカウンターへ寄る
      const goal = props.celebrating && set.shiori !== null ? set.shiori : set.game;
      if (pose.current === null) {
        pose.current = {
          position: goal.position.clone(),
          quaternion: goal.quaternion.clone(),
          yfov: goal.yfov,
        };
      }
      const t = 1 - Math.exp(-dt * 2);
      pose.current.position.lerp(goal.position, t);
      pose.current.quaternion.slerp(goal.quaternion, t);
      lift.current += (props.frame.bottom * DIALOGUE_LIFT - lift.current) * t;
      const insets = { ...NO_INSETS, bottom: Math.round(lift.current) };
      applyPose(perspective, pose.current, size.width, size.height, insets, "cover");
    }

    if (!readied.current) {
      readied.current = true;
      onReady();
    }
  });

  return (
    <>
      <Lights />
      <primitive object={interior.scene} dispose={null} />
      <primitive object={exterior.scene} dispose={null} />
      {STAFF_IDS.map((id, index) => {
        const model = staffModels[index];
        if (model === undefined) return null;
        const staff = props.staff[id];
        return (
          <Staff
            key={id}
            kind={STAFF_KIND[id]}
            model={model}
            clips={clips}
            marks={set.marks[id]}
            plan={staffPlan(id, staff, props.celebrating)}
            seq={staff.seq}
            onHead={(x, y, z) => heads.current?.[id].set(x, y, z)}
          />
        );
      })}
      {playerModel === undefined ? null : (
        <>
          <Staff
            kind="penguin"
            model={playerModel}
            clips={clips}
            marks={set.player}
            plan={playerPlan(props.celebrating, props.talking)}
            seq={props.celebrating ? 1 : 0}
            onHead={(x, y, z) => heads.current?.player.set(x, y, z)}
          />
          {/* 旅人の足もとの輪（いま動かせるキャラクターの目印） */}
          <mesh
            position={[set.player.home.x, 0.015, set.player.home.z]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <ringGeometry args={[0.34, 0.42, 48]} />
            <meshBasicMaterial color="#fff1c2" transparent opacity={0.9} toneMapped={false} />
          </mesh>
        </>
      )}
      <BubbleProjector heads={heads} />
    </>
  );
}

/** 頭の上の位置を画面の座標に変えて、吹き出しの要素に書き込む（React の描き直しをしない） */
function BubbleProjector({ heads }: { heads: React.RefObject<HeadPositions> }) {
  const { camera, size } = useThree();
  const projected = useMemo(() => new Vector3(), []);
  useFrame(() => {
    for (const id of [...STAFF_IDS, "player"] as const) {
      const head = heads.current?.[id];
      if (head === undefined) continue;
      projected.copy(head).project(camera);
      const x = ((projected.x + 1) / 2) * size.width;
      const y = ((1 - projected.y) / 2) * size.height;
      for (const element of document.querySelectorAll<HTMLElement>(`[data-bubble="${id}"]`)) {
        element.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    }
  });
  return null;
}

export default function ShopScene(props: ShopSceneProps) {
  const [ready, setReady] = useState(false);
  const heads = useRef<HeadPositions>(
    Object.fromEntries([...STAFF_IDS, "player"].map((id) => [id, new Vector3()])) as HeadPositions,
  );
  // 返事を待っているときは、コンシェルジュの上に「!」を出す（話しかけられる合図）
  const awaiting = !props.talking && props.staff.concierge.bubble === null;
  return (
    <div
      className="relative h-full w-full overflow-hidden"
      data-testid="shop-scene"
      data-ready={ready}
    >
      <Canvas
        aria-hidden="true"
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ near: 0.1, far: 200 }}
        style={{ opacity: ready ? 1 : 0, transition: "opacity 0.4s" }}
      >
        <Suspense fallback={null}>
          <Shop props={props} heads={heads} onReady={() => setReady(true)} />
        </Suspense>
      </Canvas>
      {/* 吹き出し。位置は 3D の中から毎フレーム書き込む */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {STAFF_IDS.map((id) => {
          const staff = props.staff[id];
          return ready && showsBubble(staff) ? (
            <p
              key={id}
              data-bubble={id}
              className="absolute top-0 left-0 max-w-52 rounded-2xl border-2 border-wood-700 bg-kinari-50 px-2.5 py-1 text-center font-bold text-ink text-xs leading-snug shadow-lg"
            >
              {staff.bubble}
            </p>
          ) : null;
        })}
        {ready && awaiting ? (
          <span
            data-bubble="concierge"
            className="absolute top-0 left-0 grid size-9 place-items-center rounded-full border-[3px] border-white bg-yamabuki-400 font-black text-ink text-xl shadow-lg"
          >
            !
          </span>
        ) : null}
      </div>
      {/* 旅人の「話す」。押すと会話の窓の入力欄へ */}
      {ready && props.onTalk !== undefined ? (
        <div className="pointer-events-none absolute inset-0">
          <button
            type="button"
            data-bubble="player"
            onClick={props.onTalk}
            className="pointer-events-auto absolute top-0 left-0 ml-28 flex items-center gap-2 rounded-full border-2 border-yamabuki-400 bg-ink/75 py-1 pr-4 pl-1 font-bold text-kinari-50 shadow-lg backdrop-blur-sm transition hover:bg-ink/90"
          >
            <span className="grid size-7 place-items-center rounded-full bg-kinari-50 font-black text-ink">
              A
            </span>
            {props.talkLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
