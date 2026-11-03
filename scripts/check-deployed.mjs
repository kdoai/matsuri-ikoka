// デプロイした版（Cloud Run のタグの URL か公開の URL）を、外から確かめる。費用のかかる相談は送らない。
// - /health が ok を返す
// - 画面が配られ、3D のモデル（GLB）と会話の窓の顔の絵（WebP）が届く
// - 相談の API が合言葉で守られている（合言葉なしで 401）。サービスに合言葉を設定していないこと
//   （ACCESS_PASSCODE_SET=false。モックで公開しているとき）が分かっているときは、守られていないことを知らせるだけにする
// - しおりの経路が動いている（ない旅程は 404。PDF を作れることは、同じイメージをデプロイの前にモックで確かめる）
// 使い方：[ACCESS_PASSCODE_SET=true|false] node scripts/check-deployed.mjs <URL>（省くと合言葉を求める）
import { checkFaces, checkGlb } from "./lib/served-files.mjs";

const base = process.argv[2];
if (!base) {
  console.error("使い方：node scripts/check-deployed.mjs <URL>");
  process.exit(2);
}

function check(ok, message) {
  if (!ok) throw new Error(message);
  console.log(`ok: ${message}`);
}

const health = await fetch(new URL("/health", base));
check(health.ok && (await health.json()).status === "ok", "/health");

const page = await fetch(new URL("/", base));
check(
  page.ok && (page.headers.get("content-type") ?? "").startsWith("text/html"),
  "画面が配られている",
);

const count = await checkGlb(base);
check(count > 0, `3D のモデルが配られている（${count} 件）`);

const faces = await checkFaces(base);
check(faces > 0, `顔の絵が配られている（${faces} 件）`);

const api = await fetch(new URL("/api/festivals", base));
if (process.env.ACCESS_PASSCODE_SET === "false") {
  check(api.ok, `相談の API が動いている（${api.status}。合言葉は設定されていない）`);
} else {
  check(api.status === 401, `相談の API が合言葉で守られている（${api.status}）`);
}

const shiori = await fetch(new URL("/shiori/deploy-check-missing.pdf", base));
check(shiori.status === 404, `しおりの経路が動いている（${shiori.status}）`);
