import {
  type Festival,
  type FestivalWishIntent,
  type Occurrence,
  PREFECTURES,
  type Prefecture,
  UNKNOWN,
} from "@matsuri-ikoka/schema";
import { festivalInPrefectures, REGION_PREFECTURES, resolveDestination } from "./destination";

// 祭りから探すときの、自由記述の読み取りと、祭りとの照らし合わせ（docs/spec/festival-search.md）。
// 読み取りの結果（FestivalWishIntent）は並び順にだけ効かせ、祭りの有無は変えない。
// モデルで読んだ結果も、言葉の辞書で読んだ結果も、同じ形で同じように照らし合わせる。
// 同じ意味の言葉は1つの希望として数える（「夜」「宵」が並んでも、2つの希望にしない）。

type FestivalCategory = Festival["category"];

/** 祭りのデータの値が希望に合うか：for 合う / against 合わない / null 分からない */
type FactCheck = (festival: Festival, occurrence: Occurrence) => "for" | "against" | null;

interface WishConcept {
  /** 画面に出す呼び方。読み取りの結果の terms にもこの名前で入れる */
  label: string;
  /** 祭りのデータの文に当てる言葉。自由記述の読み取りにも使う */
  words: readonly string[];
  /** 自由記述の読み取りにだけ使う言葉（祭りのデータの文に当てると誤って当たるもの） */
  triggers?: readonly string[];
  fact?: FactCheck;
}

const isSmall = (f: Festival) => f.scaleTier === "XS" || f.scaleTier === "S";
const isCrowded = (f: Festival) => f.popularity === "major" || f.scaleTier === "L";

const WISH_CONCEPTS: readonly WishConcept[] = [
  {
    label: "子連れ",
    words: ["子連れ", "子ども", "子供", "こども", "キッズ", "親子", "家族", "ファミリー"],
    triggers: ["ベビーカー", "小学生", "幼児", "赤ちゃん"],
    fact: (f) => {
      if (f.etiquette.risk !== UNKNOWN && f.etiquette.risk.level === "high") return "against";
      return f.nearby.some((spot) => spot.tags.includes("kid_friendly")) ? "for" : null;
    },
  },
  {
    label: "夜",
    words: ["夜", "宵", "夕暮れ", "夕方", "日没", "日が暮れ", "ライトアップ"],
    triggers: ["夜景", "ナイト"],
    fact: (_f, o) => {
      if ((o.start !== null && o.start >= "16:00") || (o.end !== null && o.end >= "19:00")) {
        return "for";
      }
      return o.end !== null && o.end <= "17:00" ? "against" : null;
    },
  },
  {
    label: "昼",
    words: ["昼", "日中", "午前"],
    triggers: ["朝", "明るいうち"],
    fact: (_f, o) => {
      if (o.start !== null && o.start < "15:00") return "for";
      return o.start !== null && o.start >= "17:00" ? "against" : null;
    },
  },
  {
    label: "屋台",
    words: ["屋台", "露店", "出店", "縁日"],
    triggers: ["食べ歩き", "買い食い"],
    fact: (f) => (f.food.stalls === "yes" ? "for" : f.food.stalls === "no" ? "against" : null),
  },
  {
    label: "地元の味",
    words: ["郷土料理", "地元の味", "名物", "ご当地"],
    triggers: ["グルメ", "食べ物", "美味しい", "おいしい"],
    fact: (f) => (f.food.local.length > 0 ? "for" : null),
  },
  {
    label: "静か",
    words: ["静か", "厳か", "ひっそり", "穴場"],
    triggers: ["のんびり", "ゆったり", "落ち着", "人が少な", "混まない", "混んでいない"],
    fact: (f) => (isCrowded(f) ? "against" : f.popularity === "local" && isSmall(f) ? "for" : null),
  },
  {
    label: "混雑",
    words: ["混雑", "人混み", "人ごみ"],
    triggers: ["混む", "混み合"],
    fact: (f) => (isCrowded(f) ? "for" : null),
  },
  {
    label: "賑やか",
    words: ["賑やか", "にぎやか", "活気", "熱気", "迫力", "勇壮"],
    triggers: ["盛り上が"],
    fact: (f) => (isCrowded(f) ? "for" : null),
  },
  {
    label: "写真",
    words: ["写真", "撮影", "絶景", "フォト"],
    triggers: ["映え", "カメラ", "インスタ", "撮りたい"],
    fact: (f) => {
      if (f.etiquette.photo === UNKNOWN) return null;
      if (f.etiquette.photo.policy === "prohibited") return "against";
      return f.etiquette.photo.policy === "allowed" ? "for" : null;
    },
  },
  {
    label: "歴史",
    words: ["歴史", "由来", "文化財", "無形民俗", "古式", "伝統"],
    triggers: ["昔ながら", "古い"],
    fact: (f) => (f.styles.some((s) => s.style === "traditional") ? "for" : null),
  },
  {
    label: "有名",
    words: ["定番", "代表的"],
    triggers: ["有名", "人気"],
    fact: (f) => (f.popularity === "major" ? "for" : f.popularity === "local" ? "against" : null),
  },
  {
    label: "見学",
    words: ["見学", "観覧"],
    triggers: ["見るだけ", "眺めたい"],
    fact: (f) => (f.etiquette.participation === "watch_only" ? "for" : null),
  },
  {
    label: "駅から近い",
    words: ["駅前", "駅から徒歩"],
    triggers: ["駅近", "駅から近", "電車で"],
    fact: (f) => {
      const station = f.access.stations[0];
      if (station === undefined) return null;
      return station.walkMinutes[1] <= 15 ? "for" : station.walkMinutes[0] > 30 ? "against" : null;
    },
  },
  {
    label: "車",
    words: ["駐車場"],
    triggers: ["車で", "ドライブ"],
    fact: (f) =>
      f.access.parking === "available" ? "for" : f.access.parking === "none" ? "against" : null,
  },
  { label: "海", words: ["海上", "海辺", "海岸", "海沿い", "浜辺", "砂浜", "漁港", "港町"] },
  { label: "川", words: ["河原", "川面", "川沿い", "川辺", "川原", "河川敷"] },
  { label: "山", words: ["山里", "山間", "山あい", "山中", "山頂", "山上"] },
  { label: "温泉", words: ["温泉"] },
  { label: "雪", words: ["雪", "かまくら"] },
  { label: "桜", words: ["桜", "花見"] },
  { label: "紅葉", words: ["紅葉"] },
];

const CATEGORY_WORDS: Readonly<Record<Exclude<FestivalCategory, "other">, readonly string[]>> = {
  fireworks: ["花火", "はなび"],
  float: ["山車", "曳山", "だんじり", "山鉾", "屋台囃子"],
  mikoshi: ["神輿", "みこし", "行列", "渡御"],
  dance: ["踊り", "盆踊り", "ダンス", "舞踊"],
  fire: ["火祭", "火まつり", "松明", "たいまつ", "炎", "どんど焼き"],
  lantern: ["灯籠", "灯篭", "灯ろう", "提灯", "ちょうちん", "ランタン", "竿燈"],
  performing_arts: ["神楽", "獅子舞", "太鼓", "芸能", "歌舞伎", "人形芝居"],
  ritual: ["神事", "儀式", "奉納"],
  market: ["朝市", "蚤の市", "市が立"],
};

/** 比べる形にする（全角半角・大文字小文字・カタカナとひらがなをそろえる。長さは変えない） */
function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function normalizeText(text: string): string {
  return toHiragana(text.normalize("NFKC").toLowerCase());
}

/** 言葉のあとにこれが続くと、その言葉は「そうではない」という意味になる */
const NEGATION_IN_DATA =
  /禁止|禁じ|不可|遠慮|控え|できな|ません|(?<!て)なし|無し|しない|ない[。、]?$/;

/** 文の中で言葉に当たるか。「屋台はありません」「写真は禁止」のように否定している文は当たらないとする */
function hitsText(text: string, word: string): boolean {
  let from = text.indexOf(word);
  while (from !== -1) {
    const sentenceEnd = text.indexOf("。", from);
    const tail = text.slice(from + word.length, sentenceEnd === -1 ? undefined : sentenceEnd);
    if (!NEGATION_IN_DATA.test(tail)) return true;
    from = text.indexOf(word, from + word.length);
  }
  return false;
}

/** 祭りのデータの文に、否定を除いて言葉があるか（花火があるか、など） */
export function mentions(texts: readonly string[], word: string): boolean {
  const wanted = normalizeText(word);
  return texts.some((text) => hitsText(normalizeText(text), wanted));
}

interface FestivalTexts {
  /** 名前と見どころ（重く数える） */
  primary: string[];
  /** 小話・作法・地元の味・性格の根拠・会場 */
  secondary: string[];
}

const textsCache = new WeakMap<Festival, FestivalTexts>();

function etiquetteTexts(festival: Festival): string[] {
  const { howToJoin, rules, dress, bring, risk, photo } = festival.etiquette;
  const list = (value: string[] | typeof UNKNOWN) => (value === UNKNOWN ? [] : value);
  return [
    ...(howToJoin === null || howToJoin === UNKNOWN ? [] : [howToJoin]),
    ...list(rules),
    ...list(dress),
    ...list(bring),
    ...(risk === UNKNOWN ? [] : [risk.reason]),
    ...(photo === UNKNOWN || photo.note === undefined ? [] : [photo.note]),
  ];
}

function festivalTexts(festival: Festival): FestivalTexts {
  const cached = textsCache.get(festival);
  if (cached !== undefined) return cached;
  const texts: FestivalTexts = {
    primary: [festival.name.ja, ...festival.highlights].map(normalizeText),
    secondary: [
      ...festival.trivia.map((t) => t.text),
      ...etiquetteTexts(festival),
      ...festival.food.local.flatMap((food) => [food.name, ...(food.note ? [food.note] : [])]),
      ...festival.styles.map((s) => s.basis),
      festival.venue.name,
      ...festival.municipalities.map((m) => m.name),
    ].map(normalizeText),
  };
  textsCache.set(festival, texts);
  return texts;
}

// ---------------------------------------------------------------------------
// 言葉の辞書で読む

interface DictionaryEntry {
  word: string;
  concept?: WishConcept;
  category?: FestivalCategory;
}

const DICTIONARY: readonly DictionaryEntry[] = [
  ...WISH_CONCEPTS.flatMap((concept) =>
    [...concept.words, ...(concept.triggers ?? [])].map((word) => ({
      word: normalizeText(word),
      concept,
    })),
  ),
  ...Object.entries(CATEGORY_WORDS).flatMap(([category, words]) =>
    words.map((word) => ({
      word: normalizeText(word),
      category: category as FestivalCategory,
    })),
  ),
].sort((a, b) => b.word.length - a.word.length);

const ENTRY_BY_WORD = new Map(DICTIONARY.map((entry) => [entry.word, entry]));
const CONCEPT_BY_LABEL = new Map(WISH_CONCEPTS.map((c) => [normalizeText(c.label), c]));

/** 地名の呼び方（県・都・府を除いた形と、地方の名前を含む）。長いものを先に当てる */
const PLACE_NAMES: readonly string[] = [
  ...PREFECTURES,
  ...PREFECTURES.map((p) => (p === "北海道" ? p : p.replace(/[都府県]$/, ""))),
  ...Object.keys(REGION_PREFECTURES),
].sort((a, b) => b.length - a.length);

/** 言葉のあとにこれが続くと、避けたいという意味になる */
const AVOID_AFTER =
  /^(は|が|を|の|も|で|って|とか|や)?(避け|さけ|苦手|にがて|嫌|いや|無理|むり|抜き|ぬき|なし|無し|以外|じゃな|でな|ない|しな|少な|すくな|控え|ひかえ|不要|いらな|だめ|遠慮)/;
/** 「屋台がなくても」は希望でも避けたいことでもない */
const INDIFFERENT_AFTER = /^(は|が|も)?(なくても|無くても|なくていい)/;
const JOIN_WORDS =
  /参加|加わり|くわわり|加わって|飛び入り|自分も|担ぎたい|かつぎたい|踊りたい|おどりたい|曳きたい|引きたい|体験したい|混ざりたい|まざりたい/;
const NOT_JOIN_WORDS = /参加(は|を)?(しな|せず|いい|不要)|加わらな|見るだけ|見学/;

const KANJI_MONTHS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

/** 時期の呼び方と月 */
const PERIOD_WORDS: readonly (readonly [RegExp, readonly number[]])[] = [
  [/夏休み/g, [7, 8]],
  [/ごーるでんうぃーく|gw/g, [4, 5]],
  [/お盆|おぼん/g, [8]],
  [/年末/g, [12]],
  [/お?正月|年始/g, [1]],
  [/(?<![一-龥])春(?![一-龥])/g, [3, 4, 5]],
  [/夏祭|(?<![一-龥])夏(?![一-龥])/g, [6, 7, 8]],
  [/秋祭|(?<![一-龥])秋(?![一-龥])/g, [9, 10, 11]],
  [/(?<![一-龥])冬(?![一-龥])/g, [12, 1, 2]],
];

/** 自由記述に出ても、祭りの違いを表さない言葉 */
const STOP_WORDS = new Set(
  `祭り 祭典 希望 今年 来年 今月 来月 今週 来週 週末 土日 休日 平日 連休 友達 友人 恋人 夫婦 両親 祖父母 家内 主人
  旅行 観光 一緒 初心者 大人 場所 時間 日程 予定 計画 雰囲気 感じ 気分 最高 素敵 日本 全国 地域 地方 地元 近く 遠く
  行事 体験 参加 参加型 見物 季節 開催 会場 検索 提案 紹介 条件 特に 以外 程度 大丈夫 必要 問題 興味 関心 おすすめ
  苦手 無理 不要 遠慮`
    .split(/\s+/)
    .filter(Boolean),
);

/** 読み取りの terms の上限（FestivalWishIntentSchema と同じ） */
const MAX_TERMS = 16;
const MAX_AVOID_TERMS = 8;
const MAX_TERM_LENGTH = 20;
const MAX_SUMMARY_LENGTH = 40;

function maskRange(mask: boolean[], from: number, length: number): void {
  for (let i = from; i < from + length; i += 1) mask[i] = true;
}

function isMasked(mask: readonly boolean[], from: number, length: number): boolean {
  for (let i = from; i < from + length; i += 1) if (mask[i]) return true;
  return false;
}

function summaryOf(intent: Omit<FestivalWishIntent, "summary">): string {
  const wanted = [
    ...intent.terms.map((t) => `「${t}」`),
    ...intent.categories.flatMap((category) => {
      const word = (CATEGORY_WORDS as Record<string, readonly string[]>)[category]?.[0];
      return word !== undefined && !intent.terms.includes(word) ? [`「${word}」`] : [];
    }),
    ...(intent.wantsToJoin ? ["「加わりたい」"] : []),
    ...intent.months.map((m) => `${m}月`),
    ...(intent.prefectures.length > 3 ? [] : intent.prefectures),
  ];
  const avoid = intent.avoidTerms.map((t) => `「${t}」`);
  if (wanted.length === 0 && avoid.length === 0) {
    return "希望の言葉を読み取れず、条件だけで探しました";
  }
  const avoidPart = avoid.length > 0 ? `${avoid.join("")}を避けて` : "";
  const wantedPart = wanted.length > 0 ? `${wanted.join("")}に合う祭りを` : "祭りを";
  const text = `${avoidPart}${wantedPart}探します`;
  return text.length <= MAX_SUMMARY_LENGTH ? text : `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

/**
 * 自由記述を言葉の辞書で読む。モデルが使えないとき（モックと CI、失敗や時間切れ）に使う。
 * 地名と時期を先に読み、次に長い言葉から当てて、辞書にない言葉はそのまま terms に入れる
 */
export function readWishByWords(wish: string): FestivalWishIntent {
  const base = wish.normalize("NFKC").toLowerCase();
  const kana = toHiragana(base);
  const mask = new Array<boolean>(kana.length).fill(false);

  const followedByNegation = (end: number) => AVOID_AFTER.test(kana.slice(end, end + 8));

  const prefectures = new Set<Prefecture>();
  for (const name of PLACE_NAMES) {
    const word = normalizeText(name);
    for (let at = kana.indexOf(word); at !== -1; at = kana.indexOf(word, at + word.length)) {
      if (isMasked(mask, at, word.length)) continue;
      maskRange(mask, at, word.length);
      if (followedByNegation(at + word.length)) continue;
      for (const p of resolveDestination([name]).prefectures) prefectures.add(p);
    }
  }

  const months = new Set<number>();
  for (const found of kana.matchAll(/(\d{1,2}|十[一二]?|[一二三四五六七八九])月/g)) {
    const at = found.index;
    const label = found[1] as string;
    const month = KANJI_MONTHS[label] ?? Number(label);
    if (isMasked(mask, at, found[0].length)) continue;
    maskRange(mask, at, found[0].length);
    if (month >= 1 && month <= 12 && !followedByNegation(at + found[0].length)) months.add(month);
  }
  for (const [pattern, values] of PERIOD_WORDS) {
    for (const found of kana.matchAll(pattern)) {
      if (isMasked(mask, found.index, found[0].length)) continue;
      maskRange(mask, found.index, found[0].length);
      for (const month of values) months.add(month);
    }
  }

  const terms: string[] = [];
  const avoidTerms: string[] = [];
  const categories = new Set<FestivalCategory>();
  for (const entry of DICTIONARY) {
    const { word } = entry;
    for (let at = kana.indexOf(word); at !== -1; at = kana.indexOf(word, at + word.length)) {
      if (isMasked(mask, at, word.length)) continue;
      maskRange(mask, at, word.length);
      const end = at + word.length;
      const tail = kana.slice(end, end + 8);
      if (INDIFFERENT_AFTER.test(tail)) continue;
      const original = base.slice(at, end);
      const label = entry.concept?.label ?? original;
      if (AVOID_AFTER.test(tail)) {
        if (!avoidTerms.includes(label)) avoidTerms.push(label);
        continue;
      }
      if (!terms.includes(label)) terms.push(label);
      if (entry.category !== undefined) categories.add(entry.category);
    }
  }

  // 辞書にない言葉（祭りや土地の名前など）はそのまま文に当てる
  const rest = [...base].map((c, i) => (mask[i] ? " " : c)).join("");
  for (const found of rest.matchAll(/[一-龥々ヶ]{2,}|[ァ-ヶー]{2,}|[a-z0-9]{3,}/g)) {
    const word = found[0].slice(0, MAX_TERM_LENGTH);
    if (!STOP_WORDS.has(word) && !terms.includes(word)) terms.push(word);
  }

  const wantsToJoin = JOIN_WORDS.test(kana) && !NOT_JOIN_WORDS.test(kana);
  const intent = {
    categories: [...categories],
    terms: terms.slice(0, MAX_TERMS),
    avoidTerms: avoidTerms.slice(0, MAX_AVOID_TERMS),
    months: [...months].sort((a, b) => a - b),
    prefectures: PREFECTURES.filter((p) => prefectures.has(p)),
    wantsToJoin,
  };
  return { ...intent, summary: summaryOf(intent) };
}

// ---------------------------------------------------------------------------
// 祭りと照らし合わせる

/** 重く数える一致（名前と見どころ）、ふつうの一致（ほかの文）、祭りのデータの値の一致の点 */
const PRIMARY_TEXT_POINTS = 12;
const SECONDARY_TEXT_POINTS = 8;
const FACT_POINTS = 10;
const CATEGORY_POINTS = 14;
const LITERAL_TERM_BONUS = 4;
/** 祭りの名前に言葉があるときに足す点（「神楽」と言われたら、名前に神楽のある祭りを上にする） */
const NAME_WORD_BONUS = 6;
const MONTH_POINTS = 8;
const PREFECTURE_POINTS = 8;
const JOIN_POINTS = 10;
const NAME_POINTS = 100;
const AGAINST_POINTS = -10;
const AVOID_POINTS = -15;

/** 1つの希望。同じ意味の言葉はまとめる */
interface WishGroup {
  key: string;
  label: string;
  /** 文に当てる言葉（比べる形） */
  words: string[];
  concept?: WishConcept;
  category?: FestivalCategory;
  /** 利用者やモデルの言った、そのままの言葉（種類の中で、その言葉に当たる祭りを上にする） */
  literal?: string[];
}

function groupsOf(terms: readonly string[], categories: readonly FestivalCategory[]): WishGroup[] {
  const groups = new Map<string, WishGroup>();
  const categoryGroup = (category: FestivalCategory): WishGroup => {
    const key = `category:${category}`;
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const words = (CATEGORY_WORDS as Record<string, readonly string[]>)[category] ?? [];
    const group: WishGroup = {
      key,
      label: words[0] ?? "種類",
      words: words.map(normalizeText),
      category,
      literal: [],
    };
    groups.set(key, group);
    return group;
  };
  for (const category of categories) categoryGroup(category);
  for (const term of terms) {
    const word = normalizeText(term);
    const concept = CONCEPT_BY_LABEL.get(word) ?? ENTRY_BY_WORD.get(word)?.concept;
    const category = ENTRY_BY_WORD.get(word)?.category;
    if (concept !== undefined) {
      groups.set(`concept:${concept.label}`, {
        key: `concept:${concept.label}`,
        label: concept.label,
        words: concept.words.map(normalizeText),
        concept,
      });
    } else if (category !== undefined) {
      categoryGroup(category).literal?.push(word);
    } else if (word.length >= 2) {
      groups.set(`term:${word}`, { key: `term:${word}`, label: term, words: [word] });
    }
  }
  return [...groups.values()];
}

interface GroupCheck {
  points: number;
  against: boolean;
}

function checkGroup(group: WishGroup, festival: Festival, occurrence: Occurrence): GroupCheck {
  const texts = festivalTexts(festival);
  const inPrimary = group.words.some((w) => texts.primary.some((t) => hitsText(t, w)));
  const inSecondary = group.words.some((w) => texts.secondary.some((t) => hitsText(t, w)));
  const fact = group.concept?.fact?.(festival, occurrence) ?? null;
  if (fact === "against") return { points: AGAINST_POINTS, against: true };

  let points = 0;
  if (group.category !== undefined && festival.category === group.category) {
    points = CATEGORY_POINTS;
  } else if (inPrimary) {
    points = PRIMARY_TEXT_POINTS;
  } else if (fact === "for") {
    points = FACT_POINTS;
  } else if (inSecondary) {
    points = SECONDARY_TEXT_POINTS;
  }
  const literal = group.literal?.some((w) =>
    [...texts.primary, ...texts.secondary].some((t) => hitsText(t, w)),
  );
  if (points > 0 && literal) points += LITERAL_TERM_BONUS;
  const name = texts.primary[0] as string;
  if (points > 0 && [...group.words, ...(group.literal ?? [])].some((w) => hitsText(name, w))) {
    points += NAME_WORD_BONUS;
  }
  return { points, against: false };
}

/** 開催回の日が、その月のどれかに入るか */
function occurrenceInMonths(occurrence: Occurrence, months: readonly number[]): boolean {
  const [firstYear, firstMonth] = occurrence.date.split("-").map(Number) as [number, number];
  const [lastYear, lastMonth] = (occurrence.endDate ?? occurrence.date).split("-").map(Number) as [
    number,
    number,
  ];
  const count = (lastYear - firstYear) * 12 + lastMonth - firstMonth;
  for (let i = 0; i <= count; i += 1) {
    if (months.includes(((firstMonth - 1 + i) % 12) + 1)) return true;
  }
  return false;
}

export type WishFit = "matched" | "partial" | "none";

export interface WishScore {
  points: number;
  /** 読み取れる希望がなければ null（どの祭りにも「合うと言えない」とは出さない） */
  fit: WishFit | null;
  /** 合った希望の呼び方 */
  hits: string[];
}

export const NO_WISH_SCORE: WishScore = { points: 0, fit: null, hits: [] };

/**
 * 自由記述に、祭りがどれくらい合うかを数える。
 * 同じ意味の言葉は1つの希望として数え、祭りのデータの値で合わないと分かるもの（写真の禁止など）は減点する
 */
export function scoreWish(
  festival: Festival,
  occurrence: Occurrence,
  intent: FestivalWishIntent,
  wish: string,
): WishScore {
  const groups = groupsOf(intent.terms, intent.categories);
  const hits: string[] = [];
  let points = 0;
  let wanted = 0;
  let satisfied = 0;
  let against = false;

  for (const group of groups) {
    wanted += 1;
    const check = checkGroup(group, festival, occurrence);
    points += check.points;
    if (check.against) against = true;
    if (check.points > 0) {
      satisfied += 1;
      hits.push(group.label);
    }
  }
  if (intent.months.length > 0) {
    wanted += 1;
    if (occurrenceInMonths(occurrence, intent.months)) {
      satisfied += 1;
      points += MONTH_POINTS;
      hits.push(`${intent.months.join("・")}月`);
    }
  }
  if (intent.prefectures.length > 0) {
    wanted += 1;
    if (festivalInPrefectures(festival, new Set(intent.prefectures))) {
      satisfied += 1;
      points += PREFECTURE_POINTS;
      const places = festival.municipalities
        .map((m) => m.prefecture)
        .filter((p) => intent.prefectures.includes(p));
      hits.push([...new Set(places)].join("・"));
    }
  }
  if (intent.wantsToJoin) {
    wanted += 1;
    const { participation } = festival.etiquette;
    if (participation === "join_open" || participation === "join_by_application") {
      satisfied += 1;
      points += JOIN_POINTS;
      hits.push("加わりたい");
    } else if (participation === "watch_only") {
      points += AGAINST_POINTS;
      against = true;
    }
  }

  let avoided = false;
  for (const group of groupsOf(intent.avoidTerms, [])) {
    if (checkGroup(group, festival, occurrence).points > 0) {
      avoided = true;
      points += AVOID_POINTS;
    }
  }

  const name = normalizeText(festival.name.ja);
  const named =
    normalizeText(wish).includes(name) || intent.terms.some((t) => normalizeText(t) === name);
  if (named) points += NAME_POINTS;

  const hasAvoid = intent.avoidTerms.length > 0;
  if (wanted === 0 && !hasAvoid && !named) return { points, fit: null, hits };
  let fit: WishFit;
  if (named && !avoided) fit = "matched";
  else if (wanted === 0) fit = avoided ? "none" : "matched";
  else if (satisfied === 0) fit = "none";
  else if (satisfied === wanted && !against && !avoided) fit = "matched";
  else fit = "partial";
  return { points, fit, hits };
}
