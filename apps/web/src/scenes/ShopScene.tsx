import { STAFF_IDS, type StaffId } from "@matsuri-ikoka/schema";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AnimationAction,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  Mesh,
  type Object3D,
  type PerspectiveCamera,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import { type Chatter, isConsultDesk, playStore, usePlay } from "../state/play";
import { useT } from "../state/react";
import { staffActivity } from "../state/relay";
import { NO_INSETS, type ShopSceneProps } from "../state/scene";
import type { StaffState } from "../state/types";
import { SpeechBubble, StatusChip } from "../ui/SpeechBubble";
import {
  exteriorOpacity,
  SCENE_MOTIONS,
  type SceneMotion,
  type Spot,
  STAFF_KIND,
  staffPlan,
} from "./choreography";
import {
  CAMERA_KEYS,
  CAMERA_RESET_KEY,
  CHICKS,
  clampOrbit,
  clockHands,
  DEFAULT_ORBIT,
  followOffset,
  GIMMICK_CLIPS,
  GIMMICKS,
  type Gimmick,
  gimmickNode,
  type Interaction,
  keepCameraInside,
  type Orbit,
  STICK_DEADZONE,
  TALK_RADIUS,
  type Target,
} from "./controls";
import { markEntryPlayed, resetEntry, shouldPlayEntry } from "./entry";
import { Letters } from "./Letters";
import { clipNamed, type ModelName, originalName, useModels, useSetModels } from "./models";
import { nearestOnNavMesh } from "./navmesh";
import { Player, type PlayerApi } from "./Player";
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
import { markOf, readShopWorld, type ShopWorld } from "./world";

// 3D の店内。ストアの状態（ShopSceneProps）を読むだけで、SSE のイベントは受けない。
// 旅人のペンギンは利用者が動かし、近くで使えるものと仕掛けの結果は playStore に書く。
// 吹き出しは 3D の上に HTML で重ねる（文字はストアのものか、辞書の決まった型）。
// スタッフどうしの頼みと受け渡しは、コンシェルジュの向き・頼みの吹き出し・頭の上のようす・手紙で見せる。
// 同じ情報は、画面の 2D の部品（店内のようす・会話の窓・会話の記録・店内の案内）でも文字で読める。

const MOTION_MODELS = SCENE_MOTIONS.map((name) => `motion_${name}` as ModelName);
const STAFF_MODELS = STAFF_IDS.map((id) => `staff_${STAFF_KIND[id]}` as ModelName);

/** 吹き出しを出すか（作業に向かう・作業中のときだけ）。2D の見取り図と同じ決まり */
function showsBubble(staff: StaffState): boolean {
  return staff.bubble !== null && (staff.phase === "walking" || staff.phase === "working");
}

/** 頭の上の位置。スタッフ4人と旅人 */
type HeadPositions = Record<StaffId | "player", Vector3>;

/** 客の目線のカメラ：cam.main（店の全体）から cam.shiori（カウンターに寄る）へ、この割合だけ寄せる */
const GAME_VIEW = 0.55;

/** カメラが旅人についていく割合（横・奥行き）と、いちばん動く距離（m） */
const FOLLOW = { side: 0.5, depth: 0.9, max: 2.6 };
/** カウンターの前に立つ旅人が、会話の窓の上に出るよう、カメラを手前に引く量（m） */
const PULL_BACK = 1;

/** 会話の窓の高さのうち、この割合だけ店の絵を持ち上げて、旅人を窓の上に出す */
const DIALOGUE_LIFT = 0.95;

/** 旅人がこの距離（m）より入口に近いと、入口の壁を透かす */
const ENTRANCE_NEAR = 2;
const ENTRANCE_OPACITY = 0.22;
/** のれんをくぐったとみなす距離（m） */
const NOREN_NEAR = 0.8;

/** おみくじの運勢とガチャの景品の数（文言は画面の辞書にある） */
const FORTUNES = 5;
const PRIZES = 4;

function blendPose(from: CameraPose, to: CameraPose, t: number): CameraPose {
  return {
    position: from.position.clone().lerp(to.position, t),
    quaternion: from.quaternion.clone().slerp(to.quaternion, t),
    yfov: from.yfov + (to.yfov - from.yfov) * t,
  };
}

/** 仕掛けを動かす。寝ている猫は、なでている間だけ寝息を止める */
function useGimmicks(interior: import("three/addons/loaders/GLTFLoader.js").GLTF) {
  return useMemo(() => {
    const mixer = new AnimationMixer(interior.scene);
    const sleepClip = clipNamed(interior, "gimmick.cat.sleep");
    const sleep = sleepClip === undefined ? null : mixer.clipAction(sleepClip);
    sleep?.setLoop(LoopRepeat, Number.POSITIVE_INFINITY).play();
    const actions = new Map<Gimmick, AnimationAction>();
    for (const gimmick of GIMMICKS) {
      const name = GIMMICK_CLIPS[gimmick];
      const clip = name === null ? undefined : clipNamed(interior, name);
      if (clip === undefined) continue;
      const action = mixer.clipAction(clip);
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      actions.set(gimmick, action);
    }
    const pet = actions.get("cat");
    mixer.addEventListener("finished", (event) => {
      if (event.action === pet && sleep !== null) {
        pet.stop();
        sleep.reset().play();
      }
    });
    return {
      mixer,
      play(gimmick: Gimmick) {
        const action = actions.get(gimmick);
        if (action === undefined) return;
        if (gimmick === "cat") sleep?.stop();
        action.reset().play();
      },
    };
  }, [interior]);
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
  const callbacks = useRef(props);
  callbacks.current = props;

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

  // 店内と外観を整え、目印（持ち場・待機位置・カウンター）・カメラ・遊べるものを読む
  const set = useMemo(() => {
    prepareSet(interior.scene);
    prepareSet(exterior.scene);
    const world = readShopWorld(interior.scene);
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
    return {
      world,
      marks,
      main,
      shiori,
      game: main !== null && shiori !== null ? blendPose(main, shiori, GAME_VIEW) : main,
    };
  }, [interior, exterior]);

  // カメラを回す中心：いつもの見え方の視線が、床の少し上（カウンターの高さ）と交わる点
  const pivot = useMemo(() => {
    if (set.game === null) return null;
    const forward = new Vector3(0, 0, -1).applyQuaternion(set.game.quaternion);
    const t = (PIVOT_HEIGHT - set.game.position.y) / (forward.y || -1);
    const point = set.game.position.clone().add(forward.multiplyScalar(t));
    return { point, arm: set.game.position.clone().sub(point) };
  }, [set]);
  const orbit = useRef<{ target: Orbit; current: Orbit }>({
    target: { ...DEFAULT_ORBIT },
    current: { ...DEFAULT_ORBIT },
  });
  useCameraKeys(orbit);

  const gimmicks = useGimmicks(interior);

  // 入店のカメラ：外観から店内へ入り、cam.main と同じ姿勢で止まる。1回だけ流す
  const entry = useEntryRig(exterior);
  const entering = useRef(entry !== null && shouldPlayEntry());
  // 入店のカメラが動いている間は、案内や吹き出しを出さず、旅人も動かさない
  useEffect(() => {
    playStore.getState().setEntering(entering.current);
    return () => playStore.getState().setEntering(false);
  }, []);
  const entryTime = useRef(entry?.start ?? 0);
  const pose = useRef<CameraPose | null>(null);
  const lift = useRef(entering.current ? 0 : props.frame.bottom * DIALOGUE_LIFT);
  const player = useRef(new Vector3(set.world.start.x, 0, set.world.start.z));
  const playerApi = useRef<PlayerApi>(null);
  const staffHeads = useRef<Record<StaffId, Vector3>>(
    Object.fromEntries(STAFF_IDS.map((id) => [id, new Vector3()])) as Record<StaffId, Vector3>,
  );
  const fx = useRef({ entrance: 1, underNoren: false, clockAt: 0 });

  useEffect(() => {
    if (!entering.current) {
      setOpacity(exterior.scene, 0);
    }
  }, [exterior]);

  const onGimmick = (interaction: Interaction) => {
    if (interaction.kind !== "gimmick") return;
    gimmicks.play(interaction.gimmick);
    const store = playStore.getState();
    if (interaction.gimmick === "omikuji") {
      store.notify({ kind: "omikuji", fortune: Math.floor(Math.random() * FORTUNES) });
    } else if (interaction.gimmick === "gacha") {
      store.notify({ kind: "gacha", prize: Math.floor(Math.random() * PRIZES) });
    } else {
      store.notify({ kind: "gimmick", interaction });
    }
  };

  const readied = useRef(false);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const perspective = camera as PerspectiveCamera;
    gimmicks.mixer.update(dt);
    const { world } = set;
    const at = player.current;

    if (entering.current && entry !== null) {
      entryTime.current = Math.min(entry.clip.duration, entryTime.current + dt);
      entry.mixer.setTime(entryTime.current);
      const pose = cameraPose(exterior.scene, "cam.entry");
      if (pose !== null) applyPose(perspective, pose, size.width, size.height, NO_INSETS, "cover");
      setOpacity(exterior.scene, exteriorOpacity(entryTime.current));
      if (entryTime.current >= entry.clip.duration) {
        entering.current = false;
        playStore.getState().setEntering(false);
        markEntryPlayed();
        setOpacity(exterior.scene, 0);
        // 入ると風鈴が鳴る
        gimmicks.play("furin");
      }
    } else if (set.game !== null && pivot !== null) {
      // 旅人に合わせてカメラを動かし、利用者が回した・寄せたぶんを足す。
      // しおりの完成の演出の間だけ、カウンターへ寄る
      const celebrating = props.celebrating && set.shiori !== null;
      const offset = followOffset(
        at,
        { x: world.counter.x, z: world.counter.z - PULL_BACK },
        FOLLOW,
      );
      padOrbit(orbit.current.target, dt);
      const o = orbit.current;
      const ease = 1 - Math.exp(-dt * 8);
      o.current.yaw += (o.target.yaw - o.current.yaw) * ease;
      o.current.pitch += (o.target.pitch - o.current.pitch) * ease;
      o.current.zoom += (o.target.zoom - o.current.zoom) * ease;
      const goal =
        celebrating && set.shiori !== null
          ? set.shiori
          : orbitPose(set.game, pivot, offset, o.current);
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
      lift.current += (props.frame.bottom * DIALOGUE_LIFT - lift.current) * t;
      const insets = { ...NO_INSETS, bottom: Math.round(lift.current) };
      applyPose(perspective, pose.current, size.width, size.height, insets, "cover");
    }

    // 入口の陰にいる間は、入口の壁を透かす
    const nearEntrance =
      Math.hypot(at.x - world.start.x, at.z - world.start.z) < ENTRANCE_NEAR && !entering.current;
    const wanted = nearEntrance ? ENTRANCE_OPACITY : 1;
    if (Math.abs(fx.current.entrance - wanted) > 0.005) {
      fx.current.entrance += (wanted - fx.current.entrance) * (1 - Math.exp(-dt * 6));
      if (Math.abs(fx.current.entrance - wanted) <= 0.01) fx.current.entrance = wanted;
      for (const object of world.entrance) setOpacity(object, fx.current.entrance);
    }

    // のれんをくぐると揺れる
    if (world.noren !== null) {
      const under = Math.hypot(at.x - world.noren.x, at.z - world.noren.z) < NOREN_NEAR;
      if (under && !fx.current.underNoren) gimmicks.play("noren");
      fx.current.underNoren = under;
    }

    // 時計は本物の時刻を指す（1秒ごとに合わせる）
    fx.current.clockAt -= dt;
    if (fx.current.clockAt <= 0) {
      fx.current.clockAt = 1;
      const hands = clockHands(new Date());
      if (world.clock.hour !== null) world.clock.hour.rotation.z = hands.hour;
      if (world.clock.minute !== null) world.clock.minute.rotation.z = hands.minute;
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
            id={id}
            kind={STAFF_KIND[id]}
            model={model}
            clips={clips}
            marks={set.marks[id]}
            plan={staffPlan(id, staff, props.celebrating, {
              asking: id === "concierge" && props.relay.asking !== null,
            })}
            seq={staff.seq}
            lookAt={
              id === "concierge" && props.relay.focus !== null && !props.celebrating
                ? () => {
                    const focus = callbacks.current.relay.focus;
                    return focus === null ? null : staffHeads.current[focus];
                  }
                : undefined
            }
            onHead={(x, y, z) => {
              heads.current?.[id].set(x, y, z);
              staffHeads.current[id].set(x, y, z);
            }}
          />
        );
      })}
      {playerModel === undefined ? null : (
        <Player
          model={playerModel}
          clips={clips}
          world={set.world}
          staff={staffHeads}
          celebrating={props.celebrating}
          talking={props.talking}
          position={player}
          api={playerApi}
          onHead={(x, y, z) => heads.current?.player.set(x, y, z)}
          onTalk={(staff) => {
            // 相談はコンシェルジュだけが受ける。ほかのスタッフとは、その場で短いおしゃべりをする
            if (isConsultDesk(staff)) callbacks.current.onTalk?.(staff);
            else playStore.getState().chat(staff);
          }}
          onGimmick={onGimmick}
          onPad={(command) => callbacks.current.onPad?.(command)}
          onExit={() => {
            // 次に入るときは、また通りから入店のカメラを流す
            resetEntry();
            callbacks.current.onExit?.();
          }}
        />
      )}
      <TapControls
        world={set.world}
        interior={interior.scene}
        api={playerApi}
        heads={staffHeads}
        orbit={orbit}
      />
      <Letters log={props.relay.log} heads={staffHeads} />
      <BubbleProjector heads={heads} player={player} />
    </>
  );
}

/** カメラを回す中心の高さ（m）と、ドラッグ・ホイールの効き */
const PIVOT_HEIGHT = 0.6;
const DRAG_YAW = 0.006;
const DRAG_PITCH = 0.004;
const WHEEL_ZOOM = 0.0012;
/** キー・右スティックで回す速さ（ラジアン/秒）と、寄せる速さ（倍/秒） */
const TURN_SPEED = 1.4;
const ZOOM_SPEED = 0.9;

const UP = new Vector3(0, 1, 0);

/**
 * いつもの見え方（base）を、回す中心（pivot）のまわりに回し、寄せ、旅人に合わせてずらした姿勢。
 * 0・0・1 のときは base をずらしただけになる。壁や床の中には入れない
 */
function orbitPose(
  base: CameraPose,
  pivot: { point: Vector3; arm: Vector3 },
  offset: { x: number; z: number },
  orbit: Orbit,
): CameraPose {
  const yaw = new Quaternion().setFromAxisAngle(UP, orbit.yaw);
  const right = new Vector3(1, 0, 0).applyQuaternion(base.quaternion).applyQuaternion(yaw);
  const pitch = new Quaternion().setFromAxisAngle(right, -orbit.pitch);
  const rotation = pitch.multiply(yaw);
  const center = pivot.point.clone().add(new Vector3(offset.x, 0, offset.z));
  const position = center.add(
    pivot.arm.clone().applyQuaternion(rotation).multiplyScalar(orbit.zoom),
  );
  const inside = keepCameraInside(position);
  return {
    position: new Vector3(inside.x, inside.y, inside.z),
    quaternion: rotation.multiply(base.quaternion),
    yfov: base.yfov,
  };
}

/** キーボード（Q・R で回す、Z・C で寄る・引く、V で戻す）。入力欄の中では使わない */
function useCameraKeys(orbit: React.RefObject<{ target: Orbit; current: Orbit }>): void {
  const keys = useRef(new Set<string>());
  const reset = useCallback(() => Object.assign(orbit.current.target, DEFAULT_ORBIT), [orbit]);
  useEffect(() => {
    const held = keys.current;
    const onDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.code in CAMERA_KEYS) held.add(event.code);
      // V でいつもの見え方に戻す
      if (event.code === CAMERA_RESET_KEY) reset();
    };
    const onUp = (event: KeyboardEvent) => {
      held.delete(event.code);
    };
    const clear = () => held.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
    };
  }, [reset]);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const o = orbit.current.target;
    let yaw = 0;
    let zoom = 0;
    for (const code of keys.current) {
      yaw += CAMERA_KEYS[code]?.yaw ?? 0;
      zoom += CAMERA_KEYS[code]?.zoom ?? 0;
    }
    if (yaw !== 0 || zoom !== 0) {
      Object.assign(
        o,
        clampOrbit({
          yaw: o.yaw + yaw * TURN_SPEED * dt,
          pitch: o.pitch,
          zoom: o.zoom * Math.exp(zoom * ZOOM_SPEED * dt),
        }),
      );
    }
  });
}

/** ゲームパッドの右スティックで回し、LB・RB で寄る・引く */
function padOrbit(target: Orbit, dt: number): void {
  const pad = typeof navigator.getGamepads === "function" ? navigator.getGamepads()[0] : null;
  if (!pad) return;
  const x = pad.axes[2] ?? 0;
  const y = pad.axes[3] ?? 0;
  const zoom = (pad.buttons[5]?.pressed ? 1 : 0) - (pad.buttons[4]?.pressed ? 1 : 0);
  const sx = Math.abs(x) > STICK_DEADZONE ? x : 0;
  const sy = Math.abs(y) > STICK_DEADZONE ? y : 0;
  if (sx === 0 && sy === 0 && zoom === 0) return;
  Object.assign(
    target,
    clampOrbit({
      yaw: target.yaw - sx * TURN_SPEED * dt,
      pitch: target.pitch + sy * TURN_SPEED * 0.6 * dt,
      zoom: target.zoom * Math.exp(zoom * ZOOM_SPEED * dt),
    }),
  );
}

/** 座る場所をタップしたとみなす、座面の目印からの距離（m） */
const SEAT_TAP = 0.8;

/** 透かしているもの（入口の壁） */
function faded(object: Object3D): boolean {
  if (!(object instanceof Mesh)) return false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.some((material) => material.transparent && material.opacity < 0.5);
}

/** タップした場所へ旅人を歩かせる。仕掛け・ひよこ・スタッフ・座る場所なら、着いたら使う */
function TapControls({
  world,
  interior,
  api,
  heads,
  orbit,
}: {
  world: ShopWorld;
  interior: Object3D;
  api: React.RefObject<PlayerApi | null>;
  heads: React.RefObject<Record<StaffId, Vector3>>;
  orbit: React.RefObject<{ target: Orbit; current: Orbit }>;
}) {
  const { gl, camera, scene } = useThree();
  useEffect(() => {
    const element = gl.domElement;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let down: { x: number; y: number; time: number } | null = null;
    /** 押している指・マウス（2本指で寄せる・回す） */
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let pinch: number | null = null;

    const turn = (dx: number, dy: number) => {
      const o = orbit.current.target;
      Object.assign(
        o,
        clampOrbit({ yaw: o.yaw - dx * DRAG_YAW, pitch: o.pitch + dy * DRAG_PITCH, zoom: o.zoom }),
      );
    };
    const onMove = (event: PointerEvent) => {
      const last = pointers.get(event.pointerId);
      if (last === undefined) return;
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (down !== null && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10) {
        dragged = true;
      }
      if (pointers.size >= 2) {
        // 2本指：指の間の広さで寄せ、指の動きの平均で回す
        const [a, b] = [...pointers.values()];
        if (a === undefined || b === undefined) return;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch !== null && distance > 0) {
          const o = orbit.current.target;
          Object.assign(o, clampOrbit({ ...o, zoom: o.zoom * (pinch / distance) }));
        }
        pinch = distance;
        turn(dx / 2, dy / 2);
      } else if (dragged) {
        turn(dx, dy);
      }
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const o = orbit.current.target;
      Object.assign(o, clampOrbit({ ...o, zoom: o.zoom * Math.exp(event.deltaY * WHEEL_ZOOM) }));
    };

    const targetOf = (id: string): Target | undefined =>
      world.targets.find((target) => target.id === id);

    const onDown = (event: PointerEvent) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) {
        down = { x: event.clientX, y: event.clientY, time: performance.now() };
        dragged = false;
      } else {
        // 2本目の指が触れたら、タップにはしない
        dragged = true;
        pinch = null;
      }
    };
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = null;
      const start = down;
      if (pointers.size === 0) down = null;
      if (
        start === null ||
        dragged ||
        pointers.size > 0 ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10 ||
        performance.now() - start.time > 600
      ) {
        return;
      }
      const player = api.current;
      if (player === null) return;
      const rect = element.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      // 見えないもの（歩ける床）と、透かしている入口の壁は、タップの当たりにしない
      const hit = raycaster
        .intersectObjects(scene.children, true)
        .find(
          (entry) =>
            entry.object.visible &&
            !originalName(entry.object).startsWith("nav.") &&
            !faded(entry.object),
        );
      if (hit === undefined) return;

      // 当たったものの親をたどって、何に触れたかを見分ける
      for (let node: Object3D | null = hit.object; node !== null; node = node.parent) {
        const name = originalName(node);
        const staffId = node.userData.staffId as StaffId | undefined;
        if (staffId !== undefined) {
          const head = heads.current[staffId];
          const toward = nearestOnNavMesh(world.nav, head.x, head.z);
          player.walkTo(toward, {
            id: `staff.${staffId}`,
            interaction: { kind: "talk", staff: staffId },
            stand: { x: head.x, z: head.z },
            radius: TALK_RADIUS,
            face: { x: head.x, z: head.z },
          });
          return;
        }
        const chick = CHICKS.find((n) => name === `secret.chick.${n}`);
        if (chick !== undefined) {
          const spot = world.chicks[chick] ?? { x: hit.point.x, z: hit.point.z };
          player.use(
            targetOf(`chick.${chick}`) ?? {
              id: `chick.${chick}`,
              interaction: { kind: "chick", chick },
              stand: spot,
              radius: 0,
              face: spot,
            },
          );
          return;
        }
        const gimmick = GIMMICKS.find((g) => name === gimmickNode(g));
        if (gimmick !== undefined) {
          const target = targetOf(`gimmick.${gimmick}`);
          if (target !== undefined) {
            player.walkTo(target.stand, target);
          } else {
            // 従業員の区域の仕掛けは、近づけないのでその場で動かす
            const spot = world.gimmicks[gimmick] ?? { x: hit.point.x, z: hit.point.z };
            player.use({
              id: `gimmick.${gimmick}`,
              interaction: { kind: "gimmick", gimmick },
              stand: spot,
              radius: 0,
              face: spot,
            });
          }
          return;
        }
        if (node === interior) break;
      }
      // 座る場所（ソファ・ベンチ）なら座る。従業員の区域の椅子は、柵の向こうなので知らせるだけ。
      // ほかは、その場所（に近い床）へ歩く
      const near = (point: { x: number; z: number }) =>
        Math.hypot(point.x - hit.point.x, point.z - hit.point.z) < SEAT_TAP;
      const seat = world.targets
        .filter((target) => target.interaction.kind === "sit" && near(target.face))
        .sort(
          (a, b) =>
            Math.hypot(a.face.x - hit.point.x, a.face.z - hit.point.z) -
            Math.hypot(b.face.x - hit.point.x, b.face.z - hit.point.z),
        )[0];
      if (seat !== undefined) {
        player.walkTo(seat.stand, seat);
      } else if (world.staffSeats.some(near)) {
        playStore.getState().notify({ kind: "staffOnly" });
      } else {
        player.walkTo({ x: hit.point.x, z: hit.point.z });
      }
    };
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
      element.removeEventListener("wheel", onWheel);
    };
  }, [gl, camera, scene, world, interior, api, heads, orbit]);
  return null;
}

/**
 * 頭の上の位置を画面の座標に変えて、吹き出しの要素に書き込む（React の描き直しをしない）。
 * 旅人の床の上の位置とカメラの位置も、店の要素の data-player・data-camera に書く
 * （通しテストで、歩けたか・カメラを回せたかを確かめる）
 */
function BubbleProjector({
  heads,
  player,
}: {
  heads: React.RefObject<HeadPositions>;
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
      const element = document.querySelector('[data-testid="shop-scene"]');
      element?.setAttribute("data-player", `${at.x.toFixed(2)},${at.z.toFixed(2)}`);
      element?.setAttribute(
        "data-camera",
        `${camera.position.x.toFixed(2)},${camera.position.z.toFixed(2)}`,
      );
    }
    for (const id of [...STAFF_IDS, "player"] as const) {
      const head = heads.current?.[id];
      if (head === undefined) continue;
      projected.copy(head).project(camera);
      const x = ((projected.x + 1) / 2) * size.width;
      const y = ((1 - projected.y) / 2) * size.height;
      for (const element of document.querySelectorAll<HTMLElement>(`[data-bubble="${id}"]`)) {
        // 画面の端で切れないよう、吹き出しを画面の内側に収める
        const half = element.offsetWidth / 2;
        const left = Math.min(Math.max(x, half + 8), Math.max(half + 8, size.width - half - 8));
        element.style.transform = `translate(-50%, -100%) translate(${left.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    }
  });
  return null;
}

/** おしゃべりの吹き出しを出しておく時間（ms） */
const CHATTER_MS = 4_500;

/** いま出しているおしゃべり。話しかけてから数秒で消える */
function useChatter(): Chatter | null {
  const chatter = usePlay((state) => state.chatter);
  const [shown, setShown] = useState<number | null>(null);
  // 店に入り直したときは、前に話したおしゃべりを出し直さない
  const before = useRef(playStore.getState().chatter?.seq ?? 0);
  useEffect(() => {
    if (chatter === null || chatter.seq <= before.current) return;
    setShown(chatter.seq);
    const timer = setTimeout(() => setShown(null), CHATTER_MS);
    return () => clearTimeout(timer);
  }, [chatter]);
  return chatter !== null && shown === chatter.seq ? chatter : null;
}

export default function ShopScene(props: ShopSceneProps) {
  const t = useT();
  const [ready, setReady] = useState(false);
  const chatter = useChatter();
  const chatterLines = chatter === null ? [] : t.play.chatter[chatter.staff];
  const chatterText =
    chatter === null ? null : (chatterLines[chatter.line % chatterLines.length] ?? null);
  const heads = useRef<HeadPositions>(
    Object.fromEntries([...STAFF_IDS, "player"].map((id) => [id, new Vector3()])) as HeadPositions,
  );
  // 返事を待っているときは、コンシェルジュの上に「!」を出す（話しかけられる合図）
  const entering = usePlay((state) => state.entering);
  const awaiting =
    props.dialogueOpen &&
    !props.talking &&
    props.staff.concierge.bubble === null &&
    props.relay.asking === null &&
    !entering;
  // コンシェルジュが頼んでいる間は、頼みの吹き出し（作業の種類から決まった型で作る）
  const asking = props.relay.asking;
  const requestText =
    asking === null ? null : t.relay.request[asking.task](t.staff.names[asking.to]);
  return (
    <div
      className="relative h-full w-full touch-none overflow-hidden"
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
          <Shop
            props={props}
            heads={heads}
            onReady={() => {
              setReady(true);
              props.onReady?.();
            }}
          />
        </Suspense>
      </Canvas>
      {/* 吹き出し。位置は 3D の中から毎フレーム書き込む */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {STAFF_IDS.map((id) => {
          const staff = props.staff[id];
          // 話しかけたスタッフは、作業の吹き出しの代わりに、おしゃべりを出す
          const text =
            chatter?.staff === id && chatterText !== null
              ? chatterText
              : id === "concierge" && requestText !== null
                ? requestText
                : showsBubble(staff)
                  ? staff.bubble
                  : null;
          // 頭の上のいまのようす（調べている・確かめている・まとめている など）
          const activity = props.celebrating ? null : staffActivity(id, staff, props.relay);
          const status = activity === null ? undefined : t.relay.activities[activity];
          if (!ready) return null;
          if (text === null) {
            return status === undefined ? null : (
              <StatusChip key={id} speaker={id} activity={activity ?? undefined}>
                {status}
              </StatusChip>
            );
          }
          return (
            <SpeechBubble
              key={id}
              speaker={id}
              name={t.staff.names[id]}
              status={status}
              chatter={chatter?.staff === id ? chatter.line : undefined}
            >
              {text}
            </SpeechBubble>
          );
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
      {/* おしゃべりは、吹き出しと同じ文を読み上げにも伝える */}
      <p role="status" className="sr-only">
        {chatter === null || chatterText === null
          ? ""
          : t.play.chatterSaid(t.staff.names[chatter.staff], chatterText)}
      </p>
    </div>
  );
}
