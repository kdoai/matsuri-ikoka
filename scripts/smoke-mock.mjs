// モック（MATSURI_AGENT_MODE=mock）で動いているサーバーに、サンプルの相談を最後まで流して確かめる。
// 死活監視（/health。Cloud Run の既定の URL にも向けられるように）、相談の作成、各発言の SSE が done で終わること、旅程としおりが開けることを見る。
// --pdf を付けると、しおりの PDF が作れることも見る（Chromium の入ったコンテナで使う）。
// --glb を付けると、画面が読む 3D のモデルが配られていることも見る（画面のビルドを配るサーバーで使う）。
// 使い方：node scripts/smoke-mock.mjs [--pdf] [--glb] <サーバーの URL> [サンプルの相談の JSON ...]
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { checkGlb, checkPdf } from "./lib/served-files.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [base, ...files] = args.filter((a) => !a.startsWith("--"));
if (!base) {
  console.error(
    "使い方：node scripts/smoke-mock.mjs [--pdf] [--glb] <サーバーの URL> [サンプルの相談の JSON ...]",
  );
  process.exit(2);
}

const samplesDir = path.join(import.meta.dirname, "..", "data", "samples", "conversations");
const samples =
  files.length > 0
    ? files
    : (await readdir(samplesDir))
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(samplesDir, f));

const headers = { "content-type": "application/json" };

function check(ok, message) {
  if (!ok) throw new Error(message);
  console.log(`ok: ${message}`);
}

const health = await fetch(new URL("/health", base));
check(health.ok && (await health.json()).status === "ok", "/health");

for (const file of samples) {
  const sample = JSON.parse(await readFile(file, "utf8"));
  const session = await fetch(new URL("/api/session", base), {
    method: "POST",
    headers,
    body: JSON.stringify({ sample: sample.id }),
  });
  check(session.status === 201, `${sample.id}：相談を始める`);
  const { sessionId } = await session.json();

  let itineraryId = null;
  for (const [i, turn] of sample.turns.entries()) {
    const res = await fetch(new URL("/api/chat", base), {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId, ...turn.request }),
    });
    const text = await res.text();
    check(
      res.ok && /^event: done$/m.test(text) && !/^event: error$/m.test(text),
      `${sample.id}：${i + 1}回目の発言が done で終わる`,
    );
    for (const block of text.split("\n\n")) {
      if (!block.startsWith("event: itinerary.updated\n")) continue;
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (data) itineraryId = JSON.parse(data).itinerary.id;
    }
  }

  if (itineraryId !== null) {
    const itinerary = await fetch(new URL(`/api/itinerary/${itineraryId}`, base), { headers });
    check(itinerary.ok, `${sample.id}：旅程を開ける`);
    const shiori = await fetch(new URL(`/shiori/${itineraryId}`, base));
    check(shiori.ok, `${sample.id}：しおりを開ける`);
    if (flags.has("--pdf")) {
      const bytes = await checkPdf(base, itineraryId);
      check(bytes > 0, `${sample.id}：しおりの PDF を作れる（${bytes} バイト）`);
    }
  }
}

if (flags.has("--glb")) {
  const count = await checkGlb(base);
  check(count > 0, `3D のモデルが配られている（${count} 件）`);
}
