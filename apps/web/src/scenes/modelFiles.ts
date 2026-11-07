import { SCENE_MOTIONS } from "./choreography";

// 3D のモデルのファイルを取ってくる。three.js を読み込まないので、最初の画面のコードに入れられる。
// three.js のコードを待たずに GLB を取り始め（コードとモデルを同時に取る）、取った量を読み込み中の表示に出す。
// GLB は assets/3d/models だけに置き、複製しない。
// Vite が ?url で配る（開発ではそのまま、ビルドでは dist/assets に名前にハッシュを付けて出す）。

const urls = import.meta.glob<string>("../../../../assets/3d/models/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
});

/** モデルの一覧（assets/3d/scripts の optimize が書く）。圧縮して送られたときの、元の大きさに使う */
const manifests = import.meta.glob<{ files?: { file: string; kilobytes: number }[] }>(
  "../../../../assets/3d/models/manifest.json",
  { import: "default", eager: true },
);
const rawSizes = new Map(
  Object.values(manifests)
    .flatMap((manifest) => manifest.files ?? [])
    .map((entry) => [entry.file, Math.round(entry.kilobytes * 1024)] as const),
);

/**
 * 取り終えたときのバイト数。送るときに圧縮していれば、Content-Length は圧縮した大きさで、
 * 受け取る中身（ほどいたあと）と合わないので、一覧の元の大きさを使う
 */
export function expectedSize(url: string, headers: Pick<Headers, "get">): number | null {
  if (headers.get("content-encoding") === null) {
    const length = Number(headers.get("content-length"));
    if (Number.isFinite(length) && length > 0) return length;
  }
  const file = url.split("/").pop()?.split("?")[0] ?? "";
  const name = file.replace(/-[\w-]{8}\.glb$/, ".glb");
  return rawSizes.get(name) ?? rawSizes.get(file) ?? null;
}

export type ModelName =
  | "interior"
  | "exterior"
  | "ennichi"
  | "staff_hiyoko"
  | "staff_owl"
  | "staff_hen"
  | "staff_sparrow"
  | "player_penguin"
  | `motion_${string}`;

/** 店内と外観（店の外観の画面も、2つを重ねて描く） */
export const SET_MODELS: readonly ModelName[] = ["interior", "exterior"];

/** 店内だけで使うモデル（スタッフ・旅人・モーション）。外観を見ている間に読んでおく */
export const SHOP_MODELS: readonly ModelName[] = [
  "staff_hiyoko",
  "staff_owl",
  "staff_hen",
  "staff_sparrow",
  "player_penguin",
  ...SCENE_MOTIONS.map((name) => `motion_${name}` as const),
];

/** 店内の画面が描くのに要るモデルすべて */
export const SHOP_SCENE_MODELS: readonly ModelName[] = [...SET_MODELS, ...SHOP_MODELS];

/** ガイドだけが使うモーション */
export const GUIDE_MOTIONS = ["lead", "run"] as const;
export type GuideMotion = (typeof GUIDE_MOTIONS)[number];

/** 縁日の通りが描くのに要るモデルすべて */
export const STREET_SCENE_MODELS: readonly ModelName[] = [
  "ennichi",
  "staff_hiyoko",
  "player_penguin",
  ...SCENE_MOTIONS.map((name) => `motion_${name}` as const),
  ...GUIDE_MOTIONS.map((name) => `motion_${name}` as const),
];

export function modelUrl(name: ModelName): string {
  const key = Object.keys(urls).find((path) => path.endsWith(`/${name}.glb`));
  const url = key === undefined ? undefined : urls[key];
  if (url === undefined) {
    throw new Error(`3D のモデルが見つかりません：${name}.glb`);
  }
  return url;
}

/** 1つのファイルの取り込みの進み具合。total は分からなければ null */
export interface FileProgress {
  loaded: number;
  total: number | null;
  done: boolean;
}

/**
 * いくつかのファイルの進み具合を 0〜1 にまとめる。
 * 大きさがすべて分かればバイト数で、1つでも分からなければ、取り終えたファイルの数で数える。
 */
export function overallProgress(files: readonly (FileProgress | undefined)[]): number {
  if (files.length === 0) return 1;
  const known = files.every((file) => file !== undefined && (file.done || file.total !== null));
  if (known) {
    let loaded = 0;
    let total = 0;
    for (const file of files) {
      if (file === undefined) continue;
      const size = file.total ?? file.loaded;
      total += size;
      loaded += file.done ? size : Math.min(file.loaded, size);
    }
    return total === 0 ? 1 : loaded / total;
  }
  return files.filter((file) => file?.done === true).length / files.length;
}

const progress = new Map<string, FileProgress>();
const pending = new Map<string, Promise<ArrayBuffer>>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 進み具合が変わったら知らせる（useSyncExternalStore 用） */
export function subscribeModelProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function modelProgressVersion(): number {
  return version;
}

/** モデルの取り込みの進み具合（0〜1） */
export function modelProgress(names: readonly ModelName[]): number {
  return overallProgress(names.map((name) => progress.get(modelUrl(name))));
}

async function download(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`3D のモデルを取得できませんでした（${response.status}）：${url}`);
  }
  const total = expectedSize(url, response.headers);
  const entry: FileProgress = { loaded: 0, total, done: false };
  progress.set(url, entry);
  notify();
  const body = response.body;
  if (body === null) {
    const buffer = await response.arrayBuffer();
    progress.set(url, { loaded: buffer.byteLength, total, done: true });
    notify();
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    entry.loaded += value.byteLength;
    notify();
  }
  const buffer = new Uint8Array(entry.loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  progress.set(url, { loaded: entry.loaded, total, done: true });
  notify();
  return buffer.buffer;
}

/**
 * GLB を取ってくる（同じ URL は1回だけ取る）。取り終えた中身は、読み込む側が受け取るまで持っておく。
 * 失敗したら、次に頼まれたときに取り直す
 */
export function fetchModelFile(url: string): Promise<ArrayBuffer> {
  const existing = pending.get(url);
  if (existing !== undefined) return existing;
  const request = download(url).catch((error: unknown) => {
    pending.delete(url);
    progress.delete(url);
    notify();
    throw error;
  });
  pending.set(url, request);
  return request;
}

/** 読み込む側が中身を受け取ったら、持っておく必要はない（進み具合は残す） */
export function releaseModelFile(url: string): void {
  pending.delete(url);
}

/** 先に取り始めておく（three.js のコードを待たない） */
export function prefetchModels(names: readonly ModelName[]): Promise<void> {
  return Promise.all(names.map((name) => fetchModelFile(modelUrl(name)))).then(() => undefined);
}
