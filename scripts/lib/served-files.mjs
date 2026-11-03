// 動いているサーバーが配るファイル（3D のモデルとしおりの PDF）を確かめる。
// scripts/smoke-mock.mjs（モック）と scripts/check-deployed.mjs（デプロイした版）から使う。

const GLB_MAGIC = "glTF";
const PDF_MAGIC = "%PDF-";
// 画面の入口から辿る JavaScript のファイルの数の上限（3D のモデルは遅れて読む部品の中にある）
const MAX_SCRIPTS = 40;

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`);
  return res.text();
}

/** 画面の入口（/）から JavaScript を辿り、3D のモデル（.glb）の URL を集める */
export async function findGlbUrls(base) {
  const html = await text(new URL("/", base));
  const queue = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  const seen = new Set();
  const glbs = new Set();
  while (queue.length > 0 && seen.size < MAX_SCRIPTS) {
    const script = queue.shift();
    if (seen.has(script)) continue;
    seen.add(script);
    const body = await text(new URL(script, base));
    for (const m of body.matchAll(/["'`](\/assets\/[\w-]+\.glb)["'`]/g)) glbs.add(m[1]);
    for (const m of body.matchAll(/["'`](?:\.\/|\/?assets\/)([\w-]+\.js)["'`]/g)) {
      queue.push(`/assets/${m[1]}`);
    }
  }
  return [...glbs];
}

/** 3D のモデルが GLB として配られているか（見つからない経路は index.html が返るので、中身の先頭で見る） */
export async function checkGlb(base) {
  const urls = await findGlbUrls(base);
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
