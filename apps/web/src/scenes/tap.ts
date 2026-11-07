import { type Intersection, Mesh, type Object3D } from "three";

// タップの当たりを選ぶ。three の Raycaster は visible を見ないので、
// 隠してある小物や、透かしている壁に光線が当たっても、ここで外す。

/** 自分と親がすべて表示されているか。親を隠すと、子は visible のままでも画面に出ない */
export function shownInScene(object: Object3D): boolean {
  for (let node: Object3D | null = object; node !== null; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

/** 透かしているもの（入口の壁） */
function faded(object: Object3D): boolean {
  if (!(object instanceof Mesh)) return false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  return materials.some((material) => material.transparent && material.opacity < 0.5);
}

/**
 * 光線が当たったもののうち、利用者がタップしたと言えるいちばん手前のもの。
 * 画面に出ていないもの（隠した小物、歩ける床）と、透かしている入口の壁は、当たりにしない。
 * name は GLB の元の名前を返す関数（読み込みで名前が変わることがあるため）
 */
export function firstTapHit(
  hits: Intersection[],
  name: (object: Object3D) => string,
): Intersection | undefined {
  return hits.find(
    (entry) =>
      shownInScene(entry.object) && !name(entry.object).startsWith("nav.") && !faded(entry.object),
  );
}
