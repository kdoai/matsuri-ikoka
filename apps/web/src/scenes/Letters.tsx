import type { StaffId } from "@matsuri-ikoka/schema";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, type Group, MeshStandardMaterial, type Vector3 } from "three";
import type { RelayEntry } from "../state/types";
import { LETTER_SECONDS, letterPoint } from "./choreography";

// スタッフどうしの受け渡し。渡す人の頭の上から、受け取る人の頭の上へ、手紙が山なりに渡る。
// ストアの relay.log を読むだけで、新しく増えた受け渡しを1回ずつ流す（店に入る前の分は流さない）。
// 同じことは「店内のようす」と会話の記録に文字で出る。

/** 頭の上より少し下（吹き出しと重ならない高さ）を渡す */
const BELOW_HEAD = 0.35;
const MAX_LETTERS = 6;

interface Flight {
  entry: RelayEntry;
  elapsed: number;
}

export function Letters({
  log,
  heads,
}: {
  log: readonly RelayEntry[];
  heads: React.RefObject<Record<StaffId, Vector3>>;
}) {
  const seen = useRef(log.at(-1)?.id ?? 0);
  const flights = useRef<Flight[]>([]);
  const groups = useRef<(Group | null)[]>([]);

  const paper = useMemo(() => new MeshStandardMaterial({ color: "#fffaf0", roughness: 0.8 }), []);
  const seal = useMemo(() => new MeshStandardMaterial({ color: "#c0392b", roughness: 0.6 }), []);
  const envelope = useMemo(() => new BoxGeometry(0.2, 0.13, 0.015), []);
  const dot = useMemo(() => new BoxGeometry(0.045, 0.045, 0.02), []);
  useEffect(
    () => () => {
      paper.dispose();
      seal.dispose();
      envelope.dispose();
      dot.dispose();
    },
    [paper, seal, envelope, dot],
  );

  useEffect(() => {
    const added = log.filter((entry) => entry.kind === "handoff" && entry.id > seen.current);
    seen.current = log.at(-1)?.id ?? seen.current;
    if (added.length === 0) return;
    flights.current = [...flights.current, ...added.map((entry) => ({ entry, elapsed: 0 }))].slice(
      -MAX_LETTERS,
    );
  }, [log]);

  useFrame((_, delta) => {
    const at = heads.current;
    flights.current = flights.current.filter((flight) => flight.elapsed < LETTER_SECONDS);
    for (let index = 0; index < MAX_LETTERS; index += 1) {
      const group = groups.current[index];
      if (group === null || group === undefined) continue;
      const flight = flights.current[index];
      const from = flight === undefined ? undefined : at?.[flight.entry.from];
      const to = flight === undefined ? undefined : at?.[flight.entry.to];
      if (flight === undefined || from === undefined || to === undefined) {
        group.visible = false;
        continue;
      }
      flight.elapsed += Math.min(delta, 0.1);
      const point = letterPoint(
        { x: from.x, y: from.y - BELOW_HEAD, z: from.z },
        { x: to.x, y: to.y - BELOW_HEAD, z: to.z },
        flight.elapsed / LETTER_SECONDS,
      );
      group.visible = true;
      group.position.set(point.x, point.y, point.z);
      // ひらひらと少し揺れながら渡る
      group.rotation.set(
        0.25,
        Math.atan2(to.x - from.x, to.z - from.z),
        Math.sin(flight.elapsed * 9) * 0.25,
      );
    }
  });

  return (
    <>
      {Array.from({ length: MAX_LETTERS }, (_, index) => (
        <group
          // 手紙の入れ物は数が決まっていて、並びは変わらない
          // biome-ignore lint/suspicious/noArrayIndexKey: 入れ物の番号がそのまま鍵になる
          key={index}
          ref={(group) => {
            groups.current[index] = group;
          }}
          visible={false}
        >
          <mesh geometry={envelope} material={paper} />
          <mesh geometry={dot} material={seal} position={[0, 0, 0.01]} />
        </group>
      ))}
    </>
  );
}
