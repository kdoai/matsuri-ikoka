// 動いているサーバーが配るファイル（3D のモデル・会話の窓の顔の絵・しおりの PDF）を確かめる。
// scripts/smoke-mock.mjs（モック）と scripts/check-deployed.mjs（デプロイした版）から使う。

const GLB_MAGIC = "glTF";
const PDF_MAGIC = "%PDF-";
// 会話の窓の顔の絵（assets/shiori/staff/face_*.webp）。話し手は5人
const FACE_COUNT = 5;
// 画面の入口から辿る JavaScript のファイルの数の上限（3D のモデルは遅れて読む部品の中にある）
const MAX_SCRIPTS = 40;

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`);
  return res.text();
}

/** 画面の入口（/）から JavaScript を辿り、3D のモデル（.glb）と顔の絵（face_*.webp）の URL を集める */
export async function findAssetUrls(base) {
  const html = await text(new URL("/", base));
  const queue = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  const seen = new Set();
  const glbs = new Set();
  const faces = new Set();
  while (queue.length > 0 && seen.size < MAX_SCRIPTS) {
    const script = queue.shift();
    if (seen.has(script)) continue;
    seen.add(script);
    const body = await text(new URL(script, base));
    for (const m of body.matchAll(/["'`](\/assets\/[\w-]+\.glb)["'`]/g)) glbs.add(m[1]);
    for (const m of body.matchAll(/["'`](\/assets\/face_[\w-]+\.webp)["'`]/g)) faces.add(m[1]);
    for (const m of body.matchAll(/["'`](?:\.\/|\/?assets\/)([\w-]+\.js)["'`]/g)) {
      queue.push(`/assets/${m[1]}`);
    }
  }
  return { glbs: [...glbs], faces: [...faces] };
}

/** 3D のモデルが GLB として配られているか（見つからない経路は index.html が返るので、中身の先頭で見る） */
export async function checkGlb(base) {
  const { glbs: urls } = await findAssetUrls(base);
  if (urls.length === 0)
    throw new Error("画面の JavaScript から 3D のモデル（.glb）が見つかりません");
  for (const url of urls) {
    const res = await fetch(new URL(url, base));
    const head = Buffer.from(await res.arrayBuffer())
      .subarray(0, 4)
      .toString("latin1");
    if (!res.ok || head !== GLB_MAGIC) throw new Error(`${url} が GLB として配られていません`);
  }
  return urls.length;
}

/** 会話の窓の顔の絵が WebP として配られているか（ビルドに絵がないと、画面の JavaScript に URL が出てこない） */
export async function checkFaces(base) {
  const { faces: urls } = await findAssetUrls(base);
  if (urls.length < FACE_COUNT) {
    throw new Error(
      `画面の JavaScript に顔の絵（face_*.webp）が ${urls.length} 件しかありません（${FACE_COUNT} 件のはず）`,
    );
  }
  for (const url of urls) {
    const res = await fetch(new URL(url, base));
    const body = Buffer.from(await res.arrayBuffer());
    const webp =
      body.subarray(0, 4).toString("latin1") === "RIFF" &&
      body.subarray(8, 12).toString("latin1") === "WEBP";
    if (!res.ok || !webp) throw new Error(`${url} が WebP として配られていません`);
  }
  return urls.length;
}

/** しおりの PDF が作れるか */
export async function checkPdf(base, itineraryId) {
  const res = await fetch(new URL(`/shiori/${encodeURIComponent(itineraryId)}.pdf`, base));
  const body = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  if (
    !res.ok ||
    !type.startsWith("application/pdf") ||
    !body.subarray(0, 5).equals(Buffer.from(PDF_MAGIC))
  ) {
    throw new Error(`しおりの PDF が作れません（${res.status} ${type}）`);
  }
  return body.length;
}
