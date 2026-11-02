import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type Festival,
  FestivalSchema,
  type IsoDate,
  type Prefecture,
} from "@matsuri-ikoka/schema";
import { addDays } from "../domain/calendar";

// 祭りのデータ（1件1ファイルの JSON）を起動時に読み込み、日付と場所で引ける索引を作る。
// 掲載停止（optOut: true）の祭りは読み込んだ時点で外し、検索にも参照にも出さない。

/** 複数日の開催を索引に展開するときの上限（日） */
const MAX_OCCURRENCE_DAYS = 31;
/** onDates で引ける期間の上限（日） */
const MAX_QUERY_DAYS = 120;

export interface FestivalStore {
  readonly size: number;
  get(id: string): Festival | undefined;
  list(): Festival[];
  /** from〜to のどこかで開かれる祭り（中止・延期を含む。絞り込みは domain で行う） */
  onDates(from: IsoDate, to: IsoDate): Festival[];
  /** 開催地にその都道府県を含む祭り */
  inPrefecture(prefecture: Prefecture): Festival[];
}

export function createFestivalStore(festivals: readonly Festival[]): FestivalStore {
  const byId = new Map<string, Festival>();
  const byDate = new Map<IsoDate, Set<string>>();
  const byPrefecture = new Map<Prefecture, Set<string>>();

  const index = <K>(map: Map<K, Set<string>>, key: K, id: string) => {
    const ids = map.get(key) ?? new Set<string>();
    ids.add(id);
    map.set(key, ids);
  };

  for (const festival of festivals) {
    if (festival.optOut || byId.has(festival.id)) continue;
    byId.set(festival.id, festival);
    for (const occurrence of festival.occurrences) {
      let date = occurrence.date;
      const last = occurrence.endDate ?? occurrence.date;
      for (let i = 0; date <= last && i < MAX_OCCURRENCE_DAYS; i += 1) {
        index(byDate, date, festival.id);
        date = addDays(date, 1);
      }
    }
    for (const { prefecture } of festival.municipalities) {
      index(byPrefecture, prefecture, festival.id);
    }
  }

  const resolve = (ids: Iterable<string>) =>
    [...ids].flatMap((id) => {
      const festival = byId.get(id);
      return festival === undefined ? [] : [festival];
    });

  return {
    get size() {
      return byId.size;
    },
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    onDates(from, to) {
      const ids = new Set<string>();
      let date = from;
      for (let i = 0; date <= to && i < MAX_QUERY_DAYS; i += 1) {
        for (const id of byDate.get(date) ?? []) ids.add(id);
        date = addDays(date, 1);
      }
      return resolve(ids);
    },
    inPrefecture: (prefecture) => resolve(byPrefecture.get(prefecture) ?? []),
  };
}

export interface FestivalLoadIssue {
  file: string;
  message: string;
}

export interface FestivalLoadResult {
  store: FestivalStore;
  /** 読み込んだファイルの数（掲載停止を含む） */
  loaded: number;
  /** 掲載停止で外した祭りの数 */
  optedOut: number;
  /** 読めなかったファイル。スキーマに合わないもの、ID とファイル名が違うものなど */
  issues: FestivalLoadIssue[];
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** フォルダの中の祭りの JSON をすべて読み込む。合わないファイルは除いて issues に残す */
export async function loadFestivals(dirs: readonly string[]): Promise<FestivalLoadResult> {
  const festivals: Festival[] = [];
  const issues: FestivalLoadIssue[] = [];
  const seen = new Set<string>();
  let optedOut = 0;

  for (const dir of dirs) {
    for (const file of await jsonFiles(dir)) {
      let json: unknown;
      try {
        json = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        issues.push({ file, message: `JSON として読めません：${(error as Error).message}` });
        continue;
      }
      const parsed = FestivalSchema.safeParse(json);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        issues.push({
          file,
          message:
            `スキーマに合いません：${first?.path.join(".") ?? ""} ${first?.message ?? ""}`.trim(),
        });
        continue;
      }
      const festival = parsed.data;
      if (`${festival.id}.json` !== path.basename(file)) {
        issues.push({ file, message: `id（${festival.id}）とファイル名が違います` });
        continue;
      }
      if (seen.has(festival.id)) {
        issues.push({ file, message: `id（${festival.id}）が重複しています` });
        continue;
      }
      seen.add(festival.id);
      if (festival.optOut) optedOut += 1;
      festivals.push(festival);
    }
  }

  return { store: createFestivalStore(festivals), loaded: festivals.length, optedOut, issues };
}

/**
 * 祭りのデータを読む場所。
 * - MATSURI_FESTIVALS_DIR があればそれを使う（区切りは path.delimiter）
 * - なければ data/festivals。空で、本番でなければ架空の祭り（data/samples/festivals）で開発できるようにする
 * - mock モードは、サンプルの相談に出てくる架空の祭りを読む
 */
export async function festivalDirs(options: {
  repoRoot: string;
  mode: "live" | "mock";
  configured?: string;
  production: boolean;
}): Promise<string[]> {
  const samples = path.join(options.repoRoot, "data", "samples", "festivals");
  if (options.configured) {
    return options.configured.split(path.delimiter).filter(Boolean);
  }
  if (options.mode === "mock") return [samples];
  const real = path.join(options.repoRoot, "data", "festivals");
  if ((await jsonFiles(real)).length > 0 || options.production) return [real];
  return [samples];
}
