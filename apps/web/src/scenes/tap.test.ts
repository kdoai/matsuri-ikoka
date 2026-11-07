import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Raycaster,
  Scene,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { firstTapHit, shownInScene } from "./tap";

function box(name: string, z: number, opacity = 1): Mesh {
  const mesh = new Mesh(
    new BoxGeometry(1, 1, 0.1),
    new MeshBasicMaterial({ transparent: opacity < 1, opacity }),
  );
  mesh.name = name;
  mesh.position.z = z;
  return mesh;
}

/** z の大きいほうから、原点へ向かって光線を飛ばす（カメラから見て z の大きいものが手前） */
function tap(scene: Scene): ReturnType<Raycaster["intersectObjects"]> {
  scene.updateMatrixWorld(true);
  const raycaster = new Raycaster(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
  return raycaster.intersectObjects(scene.children, true);
}

const nameOf = (object: Object3D) => object.name;

describe("タップの当たり", () => {
  it("親を隠した子は、光線が当たっても当たりにせず、奥のものを選ぶ", () => {
    const scene = new Scene();
    const staff = box("staff", 0);
    const prop = new Group();
    prop.add(box("prop.part", 2));
    prop.visible = false;
    scene.add(staff, prop);

    const hits = tap(scene);
    // Raycaster は親の visible を見ないので、隠した小物にも当たる
    expect(hits[0]?.object.name).toBe("prop.part");
    expect(firstTapHit(hits, nameOf)?.object.name).toBe("staff");
  });

  it("隠したものの孫も、当たりにしない", () => {
    const scene = new Scene();
    const hidden = new Group();
    const middle = new Group();
    middle.add(box("leaf", 1));
    hidden.add(middle);
    hidden.visible = false;
    scene.add(hidden);

    expect(firstTapHit(tap(scene), nameOf)).toBeUndefined();
  });

  it("親を見せれば、子は当たりになる", () => {
    const scene = new Scene();
    const prop = new Group();
    prop.add(box("prop.part", 1));
    scene.add(prop);

    expect(firstTapHit(tap(scene), nameOf)?.object.name).toBe("prop.part");
  });

  it("自分を隠したものも、当たりにしない", () => {
    const scene = new Scene();
    const hidden = box("hidden", 2);
    hidden.visible = false;
    scene.add(hidden, box("behind", 0));

    expect(firstTapHit(tap(scene), nameOf)?.object.name).toBe("behind");
  });

  it("歩ける床と、透かしている入口の壁は、当たりにしない", () => {
    const scene = new Scene();
    scene.add(box("nav.customer", 3), box("wall", 2, 0.2), box("counter", 1));

    expect(firstTapHit(tap(scene), nameOf)?.object.name).toBe("counter");
  });

  it("元の名前で歩ける床を見分ける", () => {
    const scene = new Scene();
    const renamed = box("nav_customer_1", 2);
    scene.add(renamed, box("counter", 1));
    const original = (object: Object3D) => (object === renamed ? "nav.customer" : object.name);

    expect(firstTapHit(tap(scene), original)?.object.name).toBe("counter");
  });
});

describe("shownInScene", () => {
  it("どの親も隠れていなければ、見えている", () => {
    const parent = new Group();
    const child = new Group();
    parent.add(child);
    expect(shownInScene(child)).toBe(true);
  });

  it("親のどれかが隠れていれば、見えていない", () => {
    const parent = new Group();
    const child = new Group();
    parent.add(child);
    parent.visible = false;
    expect(child.visible).toBe(true);
    expect(shownInScene(child)).toBe(false);
  });
});
