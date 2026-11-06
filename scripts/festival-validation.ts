// 祭りのデータのファイルを検証する。スキーマに加えて、ファイルをまたぐ決まりと確認日の古さを見る。
// ファイルの読み込みはしない（呼ぶ側が渡す）ので、テストではファイルなしで使える。
import {
  type Festival,
  FestivalSchema,
  type IsoDate,
  ResearchLedgerSchema,
  type Source,
} from "../packages/schema/src";

export const RESEARCH_LEDGER_FILE = "research-ledger.json";

export type FindingLevel = "error" | "warning";

export interface Finding {
  file: string;
  level: FindingLevel;
  message: string;
}

export interface FestivalFile {
  /** ファイル名（例：inagawa-hanabi.json） */
  name: string;
  content: string;
}

/**
 * 確認日の期限（日）。データの仕様の「情報の鮮度」に合わせる。
 * 開催日は近いほど短く、周辺の店の営業時間は30日、由来や作法などの変わりにくい情報は365日
 */
export const FRESHNESS_DAYS = {
  occurrenceWithin4Weeks: 7,
  occurrenceWithin3Months: 30,
  nearby: 30,
  stable: 365,
} as const;

const WEEKS_4 = 28;
const MONTHS_3 = 92;

/** 例示用のドメイン。テストやサンプルの出典がまぎれ込んでいないかを見る */
const EXAMPLE_HOST = /(^|\.)example\.(com|net|org)$/;

/**
 * robots.txt で取得が禁じられていると確かめたページ。出典にすると、調べ直しのたびに規約に反する。
 * 見つけたら、ここに足す
 */
const DISALLOWED_SOURCES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^https?:\/\/transit\.yahoo\.co\.jp\//, reason: "Yahoo!乗換案内" },
  {
    pattern: /^https?:\/\/(www\.)?ekitan\.com\/transit\/route\/[^?#]+\?/,
    reason: "駅探のクエリつきの経路検索",
  },
  { pattern: /^https?:\/\/(www\.)?sakigake\.jp\//, reason: "秋田魁新報" },
];

export interface ValidateOptions {
  /** 確認日の古さを測る基準の日 */
  today: IsoDate;
  /** 例示用のドメインの出典を許す（架空のデータを検証するテストだけで使う） */
  allowExampleSources?: boolean;
}

export function validateFestivalFiles(
  files: readonly FestivalFile[],
  { today, allowExampleSources = false }: ValidateOptions,
): Finding[] {
  const findings: Finding[] = [];
  const festivals: { file: string; festival: Festival }[] = [];

  for (const { name, content } of files) {
    const add = (level: FindingLevel, message: string) =>
      findings.push({ file: name, level, message });

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (error) {
      add("error", `JSON として読めません：${(error as Error).message}`);
      continue;
    }
    const parsed = FestivalSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(全体)";
        add("error", `${path}：${issue.message}`);
      }
      continue;
    }
    const festival = parsed.data;
    festivals.push({ file: name, festival });

    if (name !== `${festival.id}.json`) {
      add("error", `ファイル名を id に合わせてください（${festival.id}.json）`);
    }
    const sources = collectSources(festival);
    const examplePaths = sources
      .filter(({ source }) => EXAMPLE_HOST.test(new URL(source.url).hostname))
      .map(({ path }) => path);
    if (!allowExampleSources && examplePaths.length > 0) {
      add(
        "error",
        `例示用のドメインの出典が${examplePaths.length}件あります（${examplePaths[0]} など）。実際に確かめたページを書いてください`,
      );
    }
    for (const { path, source } of sources) {
      const disallowed = DISALLOWED_SOURCES.find(({ pattern }) => pattern.test(source.url));
      if (disallowed !== undefined) {
        add(
          "error",
          `${path}：${disallowed.reason}のページは robots.txt で取得が禁じられています。公式のアクセス案内などに替えてください`,
        );
      }
      if (source.checkedAt > today) {
        add("error", `${path}：確認した日（${source.checkedAt}）が今日より後です`);
      }
    }
    for (const message of staleMessages(festival, today)) {
      add("warning", message);
    }
  }

  findings.push(...crossFileFindings(festivals));
  return findings;
}

function crossFileFindings(festivals: readonly { file: string; festival: Festival }[]): Finding[] {
  const findings: Finding[] = [];

  const filesById = new Map<string, string[]>();
  for (const { file, festival } of festivals) {
    filesById.set(festival.id, [...(filesById.get(festival.id) ?? []), file]);
  }
  for (const [id, files] of filesById) {
    if (files.length > 1) {
      for (const file of files) {
        findings.push({
          file,
          level: "error",
          message: `id「${id}」が重複しています（${files.join("、")}）`,
        });
      }
    }
  }

  // 周辺の場所は、同じ場所ならどの祭りでも同じ id にする。同じ id で別の名前なら取り違えの疑い
  const spotNames = new Map<string, { name: string; file: string }>();
  for (const { file, festival } of festivals) {
    for (const spot of festival.nearby) {
      const seen = spotNames.get(spot.id);
      if (seen === undefined) {
        spotNames.set(spot.id, { name: spot.name, file });
      } else if (seen.name !== spot.name) {
        findings.push({
          file,
          level: "warning",
          message: `周辺の場所の id「${spot.id}」が、${seen.file} では「${seen.name}」、ここでは「${spot.name}」を指しています`,
        });
      }
    }
  }
  return findings;
}

/** 確認日が期限を過ぎた項目と、これから先の開催回がないことを、1件ずつの文で返す */
export function staleMessages(festival: Festival, today: IsoDate): string[] {
  const messages: string[] = [];
  const check = (path: string, sources: readonly Source[], limitDays: number) => {
    const latest = latestCheckedAt(sources);
    if (latest === null) return;
    const age = daysBetween(latest, today);
    if (age > limitDays) {
      messages.push(`${path}：確認から${age}日たっています（期限は${limitDays}日）`);
    }
  };

  const upcoming = festival.occurrences.filter((o) => (o.endDate ?? o.date) >= today);
  if (upcoming.length === 0) {
    messages.push("これから先の開催回がありません。次の回の開催日を調べてください");
  }
  festival.occurrences.forEach((occurrence, index) => {
    if ((occurrence.endDate ?? occurrence.date) < today) return;
    const daysUntil = Math.max(0, daysBetween(today, occurrence.date));
    const path = `occurrences.${index}（${occurrence.date}）`;
    if (daysUntil <= WEEKS_4) {
      check(path, occurrence.sources, FRESHNESS_DAYS.occurrenceWithin4Weeks);
    } else if (daysUntil <= MONTHS_3) {
      check(path, occurrence.sources, FRESHNESS_DAYS.occurrenceWithin3Months);
    } else {
      check(path, occurrence.sources, FRESHNESS_DAYS.stable);
    }
  });
  festival.nearby.forEach((spot, index) => {
    check(`nearby.${index}（${spot.name}）`, spot.sources, FRESHNESS_DAYS.nearby);
  });
  check("sources", festival.sources, FRESHNESS_DAYS.stable);
  check("etiquette.sources", festival.etiquette.sources, FRESHNESS_DAYS.stable);
  check("access.sources", festival.access.sources, FRESHNESS_DAYS.stable);
  festival.trivia.forEach((trivia, index) => {
    check(`trivia.${index}`, [trivia.source], FRESHNESS_DAYS.stable);
  });
  festival.food.local.forEach((food, index) => {
    check(`food.local.${index}（${food.name}）`, food.sources, FRESHNESS_DAYS.stable);
  });
  return messages;
}

/** 祭りの中のすべての出典を、場所（パス）つきで並べる */
function collectSources(festival: Festival): { path: string; source: Source }[] {
  const list: { path: string; source: Source }[] = [];
  const push = (path: string, sources: readonly Source[]) => {
    for (const [index, source] of sources.entries()) {
      list.push({ path: `${path}.${index}`, source });
    }
  };
  push("sources", festival.sources);
  for (const [index, trivia] of festival.trivia.entries()) {
    list.push({ path: `trivia.${index}.source`, source: trivia.source });
  }
  push("etiquette.sources", festival.etiquette.sources);
  for (const [index, occurrence] of festival.occurrences.entries()) {
    push(`occurrences.${index}.sources`, occurrence.sources);
  }
  push("access.sources", festival.access.sources);
  for (const [index, food] of festival.food.local.entries()) {
    push(`food.local.${index}.sources`, food.sources);
  }
  for (const [index, spot] of festival.nearby.entries()) {
    push(`nearby.${index}.sources`, spot.sources);
  }
  return list;
}

function latestCheckedAt(sources: readonly Source[]): IsoDate | null {
  let latest: IsoDate | null = null;
  for (const { checkedAt } of sources) {
    if (latest === null || checkedAt > latest) latest = checkedAt;
  }
  return latest;
}

/** 調査の台帳を検証する。形が崩れていればエラー、データにない祭りの記録は警告にする */
export function validateResearchLedger(
  content: string,
  festivalIds: ReadonlySet<string>,
): Finding[] {
  const file = RESEARCH_LEDGER_FILE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [{ file, level: "error", message: "JSON として読めません" }];
  }
  const ledger = ResearchLedgerSchema.safeParse(parsed);
  if (!ledger.success) {
    return ledger.error.issues.map((issue) => ({
      file,
      level: "error",
      message: `${issue.path.join(".")}: ${issue.message}`,
    }));
  }
  return Object.keys(ledger.data.festivals)
    .filter((id) => !festivalIds.has(id))
    .map((id) => ({ file, level: "warning", message: `データにない祭りの記録があります：${id}` }));
}

/** from から to までの日数（to が前なら負） */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
