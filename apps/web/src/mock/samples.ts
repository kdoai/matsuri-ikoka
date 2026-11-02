import {
  type Festival,
  FestivalSchema,
  type SampleConversation,
  SampleConversationSchema,
} from "@matsuri-ikoka/schema";
import type { FestivalSource } from "../transport/types";

// 記録した相談と、そこに出てくる架空の祭り。開発のときだけ読み込む。

const conversations = import.meta.glob<unknown>("../../../../data/samples/conversations/*.json", {
  import: "default",
});
const festivals = import.meta.glob<unknown>("../../../../data/samples/festivals/*.json", {
  import: "default",
});

function idOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1, -".json".length);
}

export function sampleIds(): string[] {
  return Object.keys(conversations).map(idOf).sort();
}

/** 記録した相談を読み込む。id がなければ、名前順で最初の相談 */
export async function loadSample(id: string | null): Promise<SampleConversation> {
  const path =
    Object.keys(conversations).find((key) => idOf(key) === id) ??
    Object.keys(conversations).sort()[0];
  const load = path === undefined ? undefined : conversations[path];
  if (load === undefined) {
    throw new Error("記録した相談が見つかりません（data/samples/conversations）");
  }
  return SampleConversationSchema.parse(await load());
}

async function loadFestival(path: string): Promise<Festival | null> {
  const load = festivals[path];
  if (load === undefined) {
    return null;
  }
  const parsed = FestivalSchema.safeParse(await load());
  return parsed.success && !parsed.data.optOut ? parsed.data : null;
}

/** 記録した相談に出てくる祭り。相談を始めたときに全部読み込み、小話に使う */
export function createSampleFestivalSource(): FestivalSource {
  return {
    async load(id) {
      const path = Object.keys(festivals).find((key) => idOf(key) === id);
      return path === undefined ? null : loadFestival(path);
    },
    async initial() {
      const all = await Promise.all(Object.keys(festivals).map(loadFestival));
      return all.filter((festival): festival is Festival => festival !== null);
    },
  };
}
