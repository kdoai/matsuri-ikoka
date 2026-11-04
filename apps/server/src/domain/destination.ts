import {
  DESTINATION_WIDEN_STAGES,
  type Festival,
  PREFECTURES,
  type Prefecture,
} from "@matsuri-ikoka/schema";

// 行き先（都道府県・地方）で祭りの候補を絞る。行き先は強く守る条件なので、広げるのは段階を追って、
// お客さまの了承を得てからにする（docs/spec/agents.md の「行き先の守り方」）。
// 1. 選んだ地域（area）の祭り
// 2. なければ、選んだ県に隣接する県（neighbor）の祭り。理由を添えて、紹介してよいかを先に聞く
// 3. それもなければ、見つからなかったと伝え、全国（nationwide）からランダムに紹介してよいかを聞く
// どの段階まで広げてよいかは、了承を得た段階（widen）で渡す。隣接する県はこの表で決め、モデルに判断させない。

/** 地方と、その中の都道府県。よく使う呼び方（北陸・東海・山陰など）も持つ */
export const REGION_PREFECTURES: Readonly<Record<string, readonly Prefecture[]>> = {
  北海道: ["北海道"],
  東北: ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"],
  関東: ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"],
  首都圏: ["埼玉県", "千葉県", "東京都", "神奈川県"],
  甲信越: ["新潟県", "山梨県", "長野県"],
  北陸: ["富山県", "石川県", "福井県"],
  中部: ["新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県"],
  東海: ["岐阜県", "静岡県", "愛知県", "三重県"],
  近畿: ["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"],
  関西: ["滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"],
  中国: ["鳥取県", "島根県", "岡山県", "広島県", "山口県"],
  山陰: ["鳥取県", "島根県"],
  山陽: ["岡山県", "広島県", "山口県"],
  四国: ["徳島県", "香川県", "愛媛県", "高知県"],
  九州: ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県"],
  九州沖縄: ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"],
};

/** 陸で境を接する都道府県の組 */
const LAND_BORDERS: readonly (readonly [Prefecture, Prefecture])[] = [
  ["青森県", "岩手県"],
  ["青森県", "秋田県"],
  ["岩手県", "秋田県"],
  ["岩手県", "宮城県"],
  ["宮城県", "秋田県"],
  ["宮城県", "山形県"],
  ["宮城県", "福島県"],
  ["秋田県", "山形県"],
  ["山形県", "福島県"],
  ["山形県", "新潟県"],
  ["福島県", "新潟県"],
  ["福島県", "群馬県"],
  ["福島県", "栃木県"],
  ["福島県", "茨城県"],
  ["茨城県", "栃木県"],
  ["茨城県", "埼玉県"],
  ["茨城県", "千葉県"],
  ["栃木県", "群馬県"],
  ["栃木県", "埼玉県"],
  ["群馬県", "埼玉県"],
  ["群馬県", "長野県"],
  ["群馬県", "新潟県"],
  ["埼玉県", "長野県"],
  ["埼玉県", "山梨県"],
  ["埼玉県", "東京都"],
  ["埼玉県", "千葉県"],
  ["千葉県", "東京都"],
  ["東京都", "神奈川県"],
  ["東京都", "山梨県"],
  ["神奈川県", "山梨県"],
  ["神奈川県", "静岡県"],
  ["新潟県", "長野県"],
  ["新潟県", "富山県"],
  ["富山県", "長野県"],
  ["富山県", "岐阜県"],
  ["富山県", "石川県"],
  ["石川県", "岐阜県"],
  ["石川県", "福井県"],
  ["福井県", "岐阜県"],
  ["福井県", "滋賀県"],
  ["福井県", "京都府"],
  ["山梨県", "長野県"],
  ["山梨県", "静岡県"],
  ["長野県", "静岡県"],
  ["長野県", "愛知県"],
  ["長野県", "岐阜県"],
  ["岐阜県", "愛知県"],
  ["岐阜県", "三重県"],
  ["岐阜県", "滋賀県"],
  ["静岡県", "愛知県"],
  ["愛知県", "三重県"],
  ["三重県", "滋賀県"],
  ["三重県", "京都府"],
  ["三重県", "奈良県"],
  ["三重県", "和歌山県"],
  ["滋賀県", "京都府"],
  ["京都府", "奈良県"],
  ["京都府", "大阪府"],
  ["京都府", "兵庫県"],
  ["大阪府", "奈良県"],
  ["大阪府", "和歌山県"],
  ["大阪府", "兵庫県"],
  ["兵庫県", "岡山県"],
  ["兵庫県", "鳥取県"],
  ["奈良県", "和歌山県"],
  ["鳥取県", "岡山県"],
  ["鳥取県", "広島県"],
  ["鳥取県", "島根県"],
  ["島根県", "広島県"],
  ["島根県", "山口県"],
  ["岡山県", "広島県"],
  ["広島県", "山口県"],
  ["徳島県", "香川県"],
  ["徳島県", "愛媛県"],
  ["徳島県", "高知県"],
  ["香川県", "愛媛県"],
  ["愛媛県", "高知県"],
  ["福岡県", "佐賀県"],
  ["福岡県", "熊本県"],
  ["福岡県", "大分県"],
  ["佐賀県", "長崎県"],
  ["熊本県", "大分県"],
  ["熊本県", "宮崎県"],
  ["熊本県", "鹿児島県"],
  ["大分県", "宮崎県"],
  ["宮崎県", "鹿児島県"],
];

/** 陸続きではないが、橋やトンネルで鉄道か道路がつながり、隣の県として行き来できる組 */
const LINKED_ACROSS_WATER: readonly (readonly [Prefecture, Prefecture])[] = [
  ["北海道", "青森県"],
  ["千葉県", "神奈川県"],
  ["兵庫県", "徳島県"],
  ["岡山県", "香川県"],
  ["広島県", "愛媛県"],
  ["山口県", "福岡県"],
];

/** 都道府県ごとの、隣接する都道府県（表の並びは都道府県の番号順） */
export const NEIGHBOR_PREFECTURES: Readonly<Record<Prefecture, readonly Prefecture[]>> = (() => {
  const table = Object.fromEntries(PREFECTURES.map((p) => [p, new Set<Prefecture>()])) as Record<
    Prefecture,
    Set<Prefecture>
  >;
  for (const [a, b] of [...LAND_BORDERS, ...LINKED_ACROSS_WATER]) {
    table[a].add(b);
    table[b].add(a);
  }
  const order = (p: Prefecture) => PREFECTURES.indexOf(p);
  return Object.fromEntries(
    PREFECTURES.map((p) => [p, [...table[p]].sort((x, y) => order(x) - order(y))]),
  ) as Record<Prefecture, Prefecture[]>;
})();

/** 名前を比べる形にする（空白・中黒・「地方」を除く） */
function normalizeName(name: string): string {
  return name
    .replace(/[\s・･、,]/g, "")
    .replace(/地方$/, "")
    .trim();
}

/** 「富山」「東京」「京都」のような、都道府県の名前の「県・都・府」を除いた呼び方 */
function shortPrefectureName(prefecture: Prefecture): string {
  return prefecture === "北海道" ? prefecture : prefecture.replace(/[都府県]$/, "");
}

const REGION_BY_NAME = new Map(
  Object.entries(REGION_PREFECTURES).map(([name, prefectures]) => [
    normalizeName(name),
    prefectures,
  ]),
);

/** 行き先として受け付ける名前（都道府県と地方） */
export function knownDestinationNames(): string[] {
  return [...PREFECTURES, ...Object.keys(REGION_PREFECTURES).filter((n) => n !== "北海道")];
}

export interface ResolvedDestination {
  /** 行き先の都道府県（番号順。重ならない） */
  prefectures: Prefecture[];
  /** 都道府県にも地方にも当たらなかった名前 */
  unknown: string[];
}

/**
 * 行き先の名前（都道府県・地方）を都道府県にする。「富山」「北陸地方」「九州・沖縄」のような呼び方も受け付ける。
 * 市町村の名前など、都道府県にも地方にも当たらない名前は unknown に返す（推測で県に当てない）
 */
export function resolveDestination(names: readonly string[]): ResolvedDestination {
  const found = new Set<Prefecture>();
  const unknown: string[] = [];
  for (const name of names) {
    const wanted = normalizeName(name);
    const region = REGION_BY_NAME.get(wanted);
    const prefecture = PREFECTURES.find((p) => p === wanted || shortPrefectureName(p) === wanted);
    if (region !== undefined) for (const p of region) found.add(p);
    else if (prefecture !== undefined) found.add(prefecture);
    else unknown.push(name);
  }
  return {
    prefectures: PREFECTURES.filter((p) => found.has(p)),
    unknown,
  };
}

/** 行き先の都道府県に隣接する都道府県（行き先そのものは除く。番号順） */
export function neighborsOf(prefectures: readonly Prefecture[]): Prefecture[] {
  const chosen = new Set(prefectures);
  const near = new Set<Prefecture>();
  for (const p of prefectures) {
    for (const n of NEIGHBOR_PREFECTURES[p]) if (!chosen.has(n)) near.add(n);
  }
  return PREFECTURES.filter((p) => near.has(p));
}

/** 祭りの開催地が、都道府県のどれかに入るか（都道府県をまたぐ祭りは、どちらかに入れば入る） */
export function festivalInPrefectures(
  festival: Pick<Festival, "municipalities">,
  prefectures: ReadonlySet<Prefecture>,
): boolean {
  return festival.municipalities.some((m) => prefectures.has(m.prefecture));
}

/**
 * 候補を探した段階。area 選んだ地域 / neighbor 隣接する県 / nationwide 全国からランダム /
 * anywhere 行き先を決めていない（おまかせ）
 */
export const DESTINATION_STAGES = DESTINATION_WIDEN_STAGES;
export type DestinationStage = (typeof DESTINATION_STAGES)[number];

export interface DestinationMatch {
  festival: Pick<Festival, "municipalities">;
  daysFromWish: number;
}

export type DestinationPick<T> =
  /** 候補を出してよい。stage は候補を探した段階 */
  | { kind: "matches"; stage: DestinationStage | "anywhere"; matches: T[]; foundIn: Prefecture[] }
  /** 選んだ地域になく、広げるにはお客さまの了承が要る。foundIn は広げた先で祭りのある都道府県 */
  | { kind: "ask"; next: Exclude<DestinationStage, "area">; foundIn: Prefecture[] }
  /** 全国にも、この日程の祭りがない */
  | { kind: "none" };

/** 祭りのある都道府県（番号順） */
function prefecturesOf<T extends DestinationMatch>(
  matches: readonly T[],
  within: ReadonlySet<Prefecture> | null,
): Prefecture[] {
  const found = new Set<Prefecture>();
  for (const m of matches) {
    for (const { prefecture } of m.festival.municipalities) {
      if (within === null || within.has(prefecture)) found.add(prefecture);
    }
  }
  return PREFECTURES.filter((p) => found.has(p));
}

/** 並びをランダムに入れ替える（Fisher–Yates）。random は 0 以上 1 未満を返す */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * 日程で探した祭り（日程とこだわりで並べたもの）を、行き先で選ぶ。
 * - 行き先がない（おまかせ）ときは、そのまま返す
 * - 選んだ地域に祭りがあれば、それだけを返す（隣の県や全国の祭りは混ぜない）
 * - なければ、隣接する県 → 全国の順に広げる。了承を得た段階（widen）より先へは広げず、ask を返す
 * - 全国から選ぶときは、希望日に開く祭りの中からランダムに並べる（希望日の祭りがなければ、前後の日の祭りから）
 */
export function pickByDestination<T extends DestinationMatch>(
  matches: readonly T[],
  options: {
    prefectures: readonly Prefecture[];
    widen: DestinationStage;
    random: () => number;
  },
): DestinationPick<T> {
  if (matches.length === 0) return { kind: "none" };
  if (options.prefectures.length === 0) {
    return { kind: "matches", stage: "anywhere", matches: [...matches], foundIn: [] };
  }
  const allowed = DESTINATION_STAGES.indexOf(options.widen);

  const area = new Set(options.prefectures);
  const inArea = matches.filter((m) => festivalInPrefectures(m.festival, area));
  if (inArea.length > 0) {
    return {
      kind: "matches",
      stage: "area",
      matches: inArea,
      foundIn: prefecturesOf(inArea, area),
    };
  }

  const near = new Set(neighborsOf(options.prefectures));
  const inNeighbors = matches.filter((m) => festivalInPrefectures(m.festival, near));
  if (inNeighbors.length > 0) {
    const foundIn = prefecturesOf(inNeighbors, near);
    return allowed >= DESTINATION_STAGES.indexOf("neighbor")
      ? { kind: "matches", stage: "neighbor", matches: inNeighbors, foundIn }
      : { kind: "ask", next: "neighbor", foundIn };
  }

  if (allowed < DESTINATION_STAGES.indexOf("nationwide")) {
    return { kind: "ask", next: "nationwide", foundIn: prefecturesOf(matches, null) };
  }
  const onWish = matches.filter((m) => m.daysFromWish === 0);
  const picked = shuffle(onWish.length > 0 ? onWish : matches, options.random);
  return {
    kind: "matches",
    stage: "nationwide",
    matches: picked,
    foundIn: prefecturesOf(picked, null),
  };
}

/** 行き先の呼び方（お客さまの言った名前を「・」でつなぐ） */
export function destinationLabel(names: readonly string[]): string {
  return names.map((n) => n.trim()).join("・");
}

/**
 * 広げる前に、お客さまに聞く文。ツールの結果から決まった型で作る（モデルに書かせない）
 */
export function destinationQuestion(
  label: string,
  ask: Extract<DestinationPick<unknown>, { kind: "ask" }>,
): string {
  if (ask.next === "neighbor") {
    return `${label}には、この日程で開く祭りが見つかりませんでした。隣の${ask.foundIn.join("・")}なら祭りがあります。こちらを紹介してもよいですか？`;
  }
  return `${label}と隣の県には、この日程で開く祭りが見つかりませんでした。日本全国で、この日程に開く祭りからランダムに紹介しましょうか？`;
}

/** 広げた段階で候補を出すときに添える理由 */
export function destinationReason(
  label: string,
  stage: DestinationStage | "anywhere",
  foundIn: readonly Prefecture[],
): string | null {
  if (stage === "neighbor") {
    return `${label}にはなかったので、隣の${foundIn.join("・")}の祭りです`;
  }
  if (stage === "nationwide") {
    return `${label}と隣の県にはなかったので、日本全国からランダムに選んだ祭りです`;
  }
  return null;
}
