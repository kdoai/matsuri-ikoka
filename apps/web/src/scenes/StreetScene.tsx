import { GUIDE_STALLS, type GuideStall } from "@matsuri-ikoka/schema";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  type AnimationClip,
  type Object3D,
  type PerspectiveCamera,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import { litStalls } from "../state/guide";
import { NO_INSETS, type StreetSceneProps } from "../state/scene";
import { SCENE_MOTIONS } from "./choreography";
import { Guide } from "./Guide";
import { GUIDE_MOTIONS } from "./modelFiles";
import { clipNamed, type ModelName, originalName, useModels } from "./models";
import { nearestOnNavMesh } from "./navmesh";
import { Player, type PlayerApi } from "./Player";
import { applyPose, type CameraPose, cameraPose, Lights, prepareSet, useRenderer } from "./stage";
import { STREET_DOLLY, STREET_LIFT, streetFollow, streetFov } from "./streetPlan";
import { readStreetWorld } from "./streetWorld";
import { firstTapHit } from "./tap";

// 3D の縁日の通り。ストアの状態（StreetSceneProps）を読むだけで、SSE のイベントは受けない。
// 店内と外観とは重ねず、ennichi.glb だけを描く。出ることはすべて、画面の屋台の一覧と会話の窓でも文字で読める。

const MOTIONS = [...SCENE_MOTIONS, ...GUIDE_MOTIONS];
const MOTION_MODELS = MOTIONS.map((name) => `motion_${name}` as ModelName);

/** 屋台の焼き込みのグループ（baked.stall_<role>）から、どの屋台に触れたかを見分ける */
function stallOfNode(name: string): GuideStall | null {
  const stall = GUIDE_STALLS.find((role) => name === `baked.stall_${role}`);
  return stall ?? null;
}

function Street({
  props,
  heads,
  onReady,
}: {
  props: StreetSceneProps;
  heads: React.RefObject<{ player: Vector3; guide: Vector3 }>;
  onReady: () => void;
}) {
  useRenderer();
  const [ennichi] = useModels(["ennichi"]);
  const [guideModel, playerModel] = useModels(["staff_hiyoko", "player_penguin"]);
  const motionModels = useModels(MOTION_MODELS);
  if (ennichi === undefined) throw new Error("縁日の通りの 3D のモデルを読み込めませんでした");
  const { camera, size } = useThree();
  const callbacks = useRef(props);
  callbacks.current = props;

  const clips = useMemo(
    () =>
      Object.fromEntries(
        MOTIONS.map((name, index) => {
          const model = motionModels[index];
          return [name, model === undefined ? undefined : clipNamed(model, name)];
        }),
      ) as Record<(typeof MOTIONS)[number], AnimationClip | undefined>,
    [motionModels],
  );

  const set = useMemo(() => {
    prepareSet(ennichi.scene);
    const world = readStreetWorld(ennichi.scene);
    const main = cameraPose(ennichi.scene, "cam.ennichi");
    const stalls = Object.fromEntries(
      GUIDE_STALLS.map((stall) => [stall, cameraPose(ennichi.scene, `cam.stall.${stall}`)]),
    ) as Record<GuideStall, CameraPose | null>;
    return { world, main, stalls };
  }, [ennichi]);

  // 灯すのはノードの表示で切り替える（マテリアルは屋台の間で共有している）
  const lit = useMemo(() => litStalls({ notices: props.notices }), [props.notices]);
  useEffect(() => {
    for (const stall of GUIDE_STALLS) {
      const lantern = set.world.lanterns[stall];
      if (lantern !== undefined) lantern.visible = lit.includes(stall);
    }
  }, [lit, set]);

  const player = useRef(new Vector3(set.world.start.x, set.world.start.y, set.world.start.z));
  const api = useRef<PlayerApi>(null);
  const guideHead = useRef({ concierge: new Vector3() });
  const pose = useRef<CameraPose | null>(null);
  const lift = useRef(props.frame.bottom * STREET_LIFT);
  const readied = useRef(false);

  // 旗で案内されたら、旅人もその屋台へ歩く。着いたら屋台を開く
  const leadSeq = props.lead?.seq ?? null;
  const walkedSeq = useRef(leadSeq);
  useEffect(() => {
    if (leadSeq === null || leadSeq === walkedSeq.current) return;
    walkedSeq.current = leadSeq;
    const stall = callbacks.current.lead?.stall;
    const target = set.world.targets.find((item) => item.id === `stall.${stall}`);
    if (target !== undefined) api.current?.walkTo(target.stand, target);
  }, [leadSeq, set]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const { main, stalls } = set;
    if (main !== null) {
      // 屋台を開いている間は、その屋台の正面に寄る。ふだんは通りを見下ろしながら旅人についていく
      const open = props.openStall === null ? null : stalls[props.openStall];
      let goal: CameraPose;
      if (open !== null) {
        goal = open;
      } else {
        const offset = streetFollow(player.current);
        const forward = new Vector3(0, 0, -1).applyQuaternion(main.quaternion);
        goal = {
          position: main.position
            .clone()
            .add(forward.multiplyScalar(STREET_DOLLY))
            .add(new Vector3(offset.x, 0, offset.z)),
          quaternion: main.quaternion,
          yfov: main.yfov,
        };
      }
      if (pose.current === null) {
        pose.current = {
          position: goal.position.clone(),
          quaternion: goal.quaternion.clone(),
          yfov: goal.yfov,
        };
      }
      const t = 1 - Math.exp(-dt * 2.5);
      pose.current.position.lerp(goal.position, t);
      pose.current.quaternion.slerp(goal.quaternion, t);
      pose.current.yfov += (goal.yfov - pose.current.yfov) * t;
      lift.current += (props.frame.bottom * STREET_LIFT - lift.current) * t;
      applyPose(
        camera as PerspectiveCamera,
        { ...pose.current, yfov: streetFov(pose.current.yfov, size.width / size.height) },
        size.width,
        size.height,
        { ...NO_INSETS, right: open !== null ? props.frame.right : 0, bottom: lift.current },
        "cover",
      );
    }
    if (!readied.current) {
      readied.current = true;
      onReady();
    }
  });

  return (
    <>
      <Lights />
      <primitive object={ennichi.scene} dispose={null} />
      {guideModel === undefined ? null : (
        <Guide
          model={guideModel}
          clips={clips}
          world={set.world}
          spot={props.spot}
          talking={props.talking}
          player={player}
          onHead={(x, y, z) => {
            guideHead.current.concierge.set(x, y, z);
            heads.current.guide.set(x, y, z);
          }}
        />
      )}
      {playerModel === undefined ? null : (
        <Player
          model={playerModel}
          clips={clips}
          world={set.world}
          staff={guideHead}
          celebrating={false}
          talking={props.talking}
          position={player}
          api={api}
          onHead={(x, y, z) => heads.current.player.set(x, y, z)}
          onTalk={() => callbacks.current.onTalk?.()}
          onGimmick={() => undefined}
          onExit={() => callbacks.current.onDoor?.()}
          onStall={(stall) => callbacks.current.onStall?.(stall)}
        />
      )}
      <StreetTap api={api} root={ennichi.scene} world={set.world} guide={guideHead} />
      <StreetProjector heads={heads} player={player} />
    </>
  );
}

/** タップした場所へ歩く。屋台やガイドなら、着いたら使う */
function StreetTap({
  api,
  root,
  world,
  guide,
}: {
  api: React.RefObject<PlayerApi | null>;
  root: Object3D;
  world: ReturnType<typeof readStreetWorld>;
  guide: React.RefObject<{ concierge: Vector3 }>;
}) {
  const { gl, camera, scene } = useThree();
  useEffect(() => {
    const element = gl.domElement;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let down: { x: number; y: number; time: number } | null = null;
    const onDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY, time: performance.now() };
    };
    const onUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      const player = api.current;
      if (
        start === null ||
        player === null ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10 ||
        performance.now() - start.time > 600
      ) {
        return;
      }
      const rect = element.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = firstTapHit(raycaster.intersectObjects(scene.children, true), originalName);
      if (hit === undefined) return;
      for (let node: Object3D | null = hit.object; node !== null; node = node.parent) {
        if (node.userData.staffId === "concierge") {
          const head = guide.current.concierge;
          player.walkTo(nearestOnNavMesh(world.nav, head.x, head.z), {
            id: "staff.concierge",
            interaction: { kind: "talk", staff: "concierge" },
            stand: { x: head.x, z: head.z },
            radius: 2,
            face: { x: head.x, z: head.z },
          });
          return;
        }
        const stall = stallOfNode(originalName(node));
        if (stall !== null) {
          const target = world.targets.find((item) => item.id === `stall.${stall}`);
          if (target !== undefined) {
            player.walkTo(target.stand, target);
            return;
          }
        }
        if (node === root) break;
      }
      const seat = world.targets.find(
        (item) =>
          item.interaction.kind === "sit" &&
          Math.hypot(item.face.x - hit.point.x, item.face.z - hit.point.z) < 0.8,
      );
      if (seat !== undefined) player.walkTo(seat.stand, seat);
      else player.walkTo(nearestOnNavMesh(world.nav, hit.point.x, hit.point.z));
    };
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointerup", onUp);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointerup", onUp);
    };
  }, [gl, camera, scene, api, root, world, guide]);
  return null;
}

/**
 * 頭の上の位置を画面の座標に変えて、札の要素に書き込む（React の描き直しをしない）。
 * 旅人の床の上の位置も data-player に書く（通しテストで、歩けたかを確かめる）
 */
function StreetProjector({
  heads,
  player,
}: {
  heads: React.RefObject<{ player: Vector3; guide: Vector3 }>;
  player: React.RefObject<Vector3>;
}) {
  const { camera, size } = useThree();
  const projected = useMemo(() => new Vector3(), []);
  const wrote = useRef(0);
  useFrame((_, delta) => {
    wrote.current -= delta;
    if (wrote.current <= 0) {
      wrote.current = 0.2;
      const at = player.current;
      document
        .querySelector('[data-testid="street-scene"]')
        ?.setAttribute("data-player", `${at.x.toFixed(2)},${at.z.toFixed(2)}`);
    }
    const pairs = [
      ["player", heads.current.player],
      ["concierge", heads.current.guide],
    ] as const;
    for (const [id, head] of pairs) {
      projected.copy(head).project(camera);
      const x = ((projected.x + 1) / 2) * size.width;
      const y = ((1 - projected.y) / 2) * size.height;
      for (const element of document.querySelectorAll<HTMLElement>(`[data-bubble="${id}"]`)) {
        const half = element.offsetWidth / 2;
        const left = Math.min(Math.max(x, half + 8), Math.max(half + 8, size.width - half - 8));
        element.style.transform = `translate(-50%, -100%) translate(${left.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    }
  });
  return null;
}

export default function StreetScene(props: StreetSceneProps) {
  const [ready, setReady] = useState(false);
  const heads = useRef({ player: new Vector3(), guide: new Vector3() });
  const lit = useMemo(() => litStalls({ notices: props.notices }), [props.notices]);
  return (
    <div
      className="relative h-full w-full touch-none overflow-hidden"
      data-testid="street-scene"
      data-ready={ready}
      data-lit={lit.join(",")}
      data-guide-spot={props.spot}
    >
      <Canvas
        aria-hidden="true"
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ near: 0.1, far: 200 }}
        style={{ opacity: ready ? 1 : 0, transition: "opacity 0.4s" }}
      >
        <Suspense fallback={null}>
          <Street
            props={props}
            heads={heads}
            onReady={() => {
              setReady(true);
              props.onReady?.();
            }}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
