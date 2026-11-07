// ガイドの手帳に残してよい文かを、コードで確かめる（docs/spec/guide.md の「ガイドの手帳」）。
// - 現在地、体調の詳しい内容、連絡先、秘密の値は残さない
// - 残すのは利用者が話したことだけ。ページや見回りの結果の文は、発言と照らして通さない
// 見分けられなかった文は残さないほうへ倒す。残せるのは、同行者の好み・ペース・避けたいことのような短い言い方。
// 理由は種類だけを返し、文そのものをログに残さない。
// 調べ役へ渡す文と調べ役の答え（privateValueRefusal）は、値の形だけを見る。秘密の言葉も、あとに値が続くときだけ断る
// （「屋台でカードは使えますか」は調べてよい）。

export type MemoRefusal = "location" | "health" | "contact" | "secret" | "not_from_user";

const REFUSAL_MESSAGES: Record<MemoRefusal, string> = {
  location: "現在地や住まいの場所は、手帳に残しません",
  health:
    "体調の詳しい内容は、手帳に残しません（「ゆっくり歩く」「そばは避ける」のように書けます）",
  contact: "連絡先は、手帳に残しません",
  secret: "秘密の値は、手帳に残しません",
  not_from_user:
    "利用者がこの発言で話したことだけを、話した言葉のまま短く残せます。言い足しや言い換えはできません",
};

export function memoRefusalMessage(refusal: MemoRefusal): string {
  return REFUSAL_MESSAGES[refusal];
}

// ---------------------------------------------------------------------------
// 居場所

const LOCATION_WORDS = [
  "現在地",
  "今いる",
  "いまいる",
  "緯度",
  "経度",
  "住所",
  "住ん",
  "住まい",
  "在住",
  "実家",
  "自宅",
  "番地",
  "丁目",
  "号室",
  "部屋番号",
  "ホテルの部屋",
  "郵便番号",
  "〒",
];
const COORDINATES = /[0-9]{1,3}\.[0-9]{3,}/;
/** 「東京駅にいます」「駅に着きました」のような、いまの居場所の言い方 */
const STAYING_AT = /(?:にいる|にいます|にいました|に居|に着いた|に着きました|に到着)/;
/** 「今は渋谷駅です」のような言い方。「今回」「今日」「今後」などには当てない */
const HERE_NOW =
  /(?:今(?![回度年日後月週晩朝夜])|いま(?!いち)|現在)[^。]{0,20}(?:駅|空港|ホテル|旅館|会場|バス停|港|町|市|区|村|県|の近く|付近)/;
/** 「渋谷駅です」「渋谷駅の前です」のような言い方。「駅の階段は避ける」「駅から近い宿」には当てない */
const AT_PLACE =
  /(?:駅|空港|ホテル|旅館|会場|バス停|港|ロビー)(?:の?(?:前|近く|そば|外|中|北口|南口|東口|西口|中央口|改札|出口|入口|ホーム|ロビー))?(?:です|だよ|だ$|にて|$)/;
/** 「北口で待っています」のような言い方。「待つのは苦手」には当てない */
const WAITING_AT = /で待っ(?:て|た)/;
/** 住所の形。「東京都渋谷区」「道玄坂1-2-3」。「京都の町並み」「京都で町歩き」には当てない */
const ADDRESS =
  /[都道府県][^。、のでをはがにともへ]{1,6}[市区町村]|(?<![0-9])[0-9]{1,3}-[0-9]{1,4}-[0-9]{1,4}(?![0-9])/;

// ---------------------------------------------------------------------------
// 体のこと

const HEALTH_WORDS = [
  "病",
  "症",
  "痛",
  "治療",
  "癌",
  "ガン",
  "車椅子",
  "車いす",
  "くるまいす",
  "杖",
  "歩行器",
  "補聴器",
  "透析",
  "ペースメーカー",
  "介助",
  "介護",
  "リハビリ",
  "吐",
  "嘔",
  "下痢",
  "便秘",
  "貧血",
  "酔い",
  "骨折",
  "捻挫",
  "ねんざ",
  "怪我",
  "ケガ",
  "出血",
  "発熱",
  "微熱",
  "熱がある",
  "熱が出",
  "咳",
  "鼻水",
  "息切れ",
  "妊",
  "つわり",
  "産後",
  "アレルギー",
  "障害",
  "障がい",
  "通院",
  "入院",
  "手術",
  "医師",
  "医者",
  "薬",
  "くすり",
  "服用",
  "処方",
  "インスリン",
  "視力",
  "耳が遠",
  "心臓",
  "血圧",
  "糖尿",
  "喘息",
  "ぜんそく",
  "精神",
  "メンタル",
  "鬱",
  "パニック",
  "不眠",
  "発作",
  "てんかん",
  "認知",
  "生理",
  "体調",
  "具合",
  "気分が悪",
  "診断",
  "めまい",
  "倦怠",
  "だるい",
  "しびれ",
  "腫れ",
  "腎",
  "肝臓",
  "肝炎",
  "膵臓",
  "血糖",
  "血液",
  "脳",
  "腫瘍",
  "関節",
  "過呼吸",
  "ぎっくり",
  "ヘルニア",
  "リウマチ",
  "不整脈",
  "動悸",
  "免疫",
  "胃腸",
  "腸炎",
  "HIV",
  "エイズ",
  "陽性",
  "陰性",
  "コロナ",
  "感染",
  "酸素",
  "人工肛門",
  "ストーマ",
  "義足",
  "義手",
  "義眼",
  "難聴",
  "失明",
  "弱視",
  "聴力",
  "視覚",
  "聴覚",
  "手話",
  "更年期",
  "自閉",
  "ADHD",
  "摂食",
  "拒食",
  "過食",
];
const HEALTH_PATTERNS = [
  /がん(?:治療|患者|検診|の|を|で)/,
  /うつ(?:病|状)/,
  // 「だけが」「おでかけが」には当てない
  /(?<![だかつづあわ])けが(?:を|し|で|が|です|人)/,
  /(?:足|脚|膝|ひざ|腰|こし|背中|肩|首|目|耳|胸|お腹|おなか|腹|胃|肺|頭|歯|喉|のど)(?:が|も|は)?(?:悪|弱|いた|わる|よわ|不自由|見えな|聞こえな|見えにく|聞こえにく|見えづら|聞こえづら)/,
];

// ---------------------------------------------------------------------------
// 連絡先と秘密の値

const CONTACT_WORDS = [
  "電話",
  "連絡先",
  "番号",
  "メール",
  "e-mail",
  "LINE",
  "インスタ",
  "ツイッター",
  "アカウント",
  "携帯",
];
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** 「tanaka at example dot com」のように綴ったメールアドレス */
const SPELLED_EMAIL =
  /[a-z0-9._-]+\s*(?:\bat\b|アット|あっと)\s*[a-z0-9-]+\s*(?:\bdot\b|ドット|どっと)\s*[a-z]{2,}/i;
/** 電話番号（区切りあり・なし）。10桁以上の数字の並び。手帳の文は空白を除いて比べる */
const PHONE = /(?:[0-9][-()]?){10,}/;
/** 空白で区切って書いた電話番号。0 から始まる3つの組 */
const SPACED_PHONE = /(?<![0-9])0[0-9]{1,4}[\s-]+[0-9]{1,4}[\s-]+[0-9]{3,4}(?![0-9])/;
/** + から始まる国際形式の電話番号 */
const INTERNATIONAL_PHONE = /\+\s*[0-9][0-9\s()-]{7,}/;
/** 4桁の塊が4つ（カードの番号） */
const CARD_NUMBER = /(?<![0-9])[0-9]{4}[\s-]+[0-9]{4}[\s-]+[0-9]{4}[\s-]+[0-9]{4}(?![0-9])/;
/** 日付と時刻の形。数字を数える前に除く（「2026-11-15 18:00」は電話番号にならない） */
const DATE_OR_TIME =
  /(?<![0-9])[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2}(?![0-9])|(?<![0-9])[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?(?![0-9])/g;
/** 空白・ハイフン・かっこで区切った数字の並び。行をまたがない */
const DIGIT_RUN = /[0-9](?:[ \t()-]*[0-9])*/g;
/** 電話番号とみなす、数字の合計の下限 */
const MIN_PHONE_DIGITS = 10;

/** 日付と時刻の形でない数字の並びのうち、数字の合計が電話番号ほどあるものがあるか */
function hasLongDigitRun(value: string): boolean {
  const rest = value.replaceAll(DATE_OR_TIME, "|");
  return [...rest.matchAll(DIGIT_RUN)].some(
    ([run]) => run.replaceAll(/[^0-9]/g, "").length >= MIN_PHONE_DIGITS,
  );
}

/** ドメインの形。あとに続く「/」「?」なども取って、ドメインかどうかを見分ける */
const DOMAIN_LIKE = /([a-z0-9-]+)\.([a-z]{2,})((?:\.[a-z]|[/?#:])?)/gi;
/** 人や場所の名前の前に付く略語（「Mt.Fuji」「St.Regis」「Dr.Yellow」「JR.East」） */
const NAME_ABBREVIATIONS = new Set([
  "mt",
  "st",
  "dr",
  "mr",
  "ms",
  "mrs",
  "prof",
  "jr",
  "no",
  "sr",
  "ft",
]);
/** 略語のあとでもドメインとみなす語（「Dr.Com」「St.Xyz」） */
const COMMON_TLDS = new Set([
  "com",
  "net",
  "org",
  "info",
  "biz",
  "xyz",
  "top",
  "site",
  "online",
  "club",
  "app",
  "dev",
  "io",
  "co",
  "jp",
  "me",
  "ly",
  "gg",
  "tv",
  "cc",
  "to",
  "uk",
  "us",
]);

/** 「Mt.Fuji」のような、略語で始まる固有名詞か。頭文字が大文字で、あとにパスが続かないものだけ */
function isNameWithAbbreviation(label: string, word: string, after: string): boolean {
  return (
    after === "" &&
    /^[A-Z]/.test(label) &&
    /^[A-Z][a-z]/.test(word) &&
    NAME_ABBREVIATIONS.has(label.toLowerCase()) &&
    !COMMON_TLDS.has(word.toLowerCase())
  );
}

/** スキームつきか、ドメインの形の URL があるか */
function hasUrl(value: string): boolean {
  if (/https?:\/\//i.test(value)) return true;
  return [...value.matchAll(DOMAIN_LIKE)].some(
    ([, label = "", word = "", after = ""]) => !isNameWithAbbreviation(label, word, after),
  );
}

const SECRET_WORDS = [
  "パスワード",
  "パスコード",
  "暗証",
  "合言葉",
  "クレジット",
  "クレカ",
  "カード番号",
  "口座",
  "マイナンバー",
  "パスポート",
  "保険証",
  "免許証",
  "トークン",
  "APIキー",
  "ログイン",
  "password",
  "passcode",
  "secret",
];
const PIN = /(?<![a-z])pin(?![a-z])/i;
/** 鍵やトークンに見える、英字と数字の混ざった長い文字列 */
const TOKEN_LIKE = /(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,}/;

const SECRET_NAME =
  "(?:パスワード|パスコード|暗証番号|暗証|合言葉|カード番号|口座番号|マイナンバー|トークン|apiキー|api\\s*key|password|passcode|pin(?:\\s*code)?|ピン(?:コード|番号))";
const SECRET_CHARS = "[a-z0-9!#$%&*+._~^-]";
/** 秘密の言葉のあとに値が続く形。「パスワードのいらない」「パスワードは必要ですか」には当てない */
const SECRET_VALUES = [
  // 「パスワードは hunter2」「password: hunter2」
  new RegExp(`(?<![a-z])${SECRET_NAME}\\s*(?:は|が|:|=)\\s*[「『"']?${SECRET_CHARS}{3,}`, "i"),
  // 「合言葉は「やま」」
  new RegExp(`(?<![a-z])${SECRET_NAME}\\s*(?:は|が|:|=)\\s*[「『"'][^」』"']+`, "i"),
  // 「暗証番号 1234」「password is hunter2」。数字があるときだけ（「password is required」には当てない）
  new RegExp(
    `(?<![a-z])${SECRET_NAME}\\s*(?:is\\s+)?(?=${SECRET_CHARS}*[0-9])${SECRET_CHARS}{3,}`,
    "i",
  ),
];

// ---------------------------------------------------------------------------

/** 全角と半角をならし、数字の間の長音記号やマイナス記号をハイフンにする。空白は残す */
function spaced(text: string): string {
  return text.normalize("NFKC").replaceAll(/(?<=[0-9])[ー−‐‑–—―](?=[0-9])/g, "-");
}

function joined(text: string): string {
  return spaced(text).replaceAll(/\s+/g, "");
}

/**
 * 文の中に、連絡先・URL・座標・秘密の値の形をしたものがあるか。なければ null。
 * Web の調べ役へ渡す文と、調べ役の答えに使う（調べ役に利用者の情報を持たせず、外へ送らせないため）。
 * 値の形だけを見るので、「クレジットカードは使えますか」は通る。数字の合計が10桁以上の並びは連絡先と
 * みなすが、日付と時刻の形は除くので、「2026-11-15 18:00」は電話番号にならない
 */
export function privateValueRefusal(
  text: string,
): Exclude<MemoRefusal, "health" | "not_from_user"> | null {
  const value = spaced(text);
  if (
    TOKEN_LIKE.test(value) ||
    CARD_NUMBER.test(value) ||
    SECRET_VALUES.some((pattern) => pattern.test(value))
  ) {
    return "secret";
  }
  if (
    EMAIL.test(value) ||
    SPELLED_EMAIL.test(value) ||
    INTERNATIONAL_PHONE.test(value) ||
    SPACED_PHONE.test(value) ||
    hasLongDigitRun(value)
  ) {
    return "contact";
  }
  if (hasUrl(value)) return "contact";
  if (COORDINATES.test(value)) return "location";
  return null;
}

/** 手帳に残さない内容か。残してよければ null */
export function memoContentRefusal(text: string): MemoRefusal | null {
  const found = privateValueRefusal(text);
  if (found !== null) return found;
  const value = joined(text);
  const lower = value.toLowerCase();
  if (PIN.test(spaced(text)) || SECRET_WORDS.some((word) => lower.includes(word.toLowerCase()))) {
    return "secret";
  }
  if (TOKEN_LIKE.test(value)) return "secret";
  if (PHONE.test(value) || hasUrl(value)) return "contact";
  if (CONTACT_WORDS.some((word) => lower.includes(word.toLowerCase()))) return "contact";
  if (
    STAYING_AT.test(value) ||
    HERE_NOW.test(value) ||
    AT_PLACE.test(value) ||
    WAITING_AT.test(value) ||
    ADDRESS.test(value) ||
    LOCATION_WORDS.some((word) => value.includes(word))
  ) {
    return "location";
  }
  if (
    HEALTH_PATTERNS.some((pattern) => pattern.test(value)) ||
    HEALTH_WORDS.some((word) => lower.includes(word.toLowerCase()))
  ) {
    return "health";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 利用者が話したことか

/** 2文字ずつの並びの集まり（日本語の言い換えでも、同じ言葉の重なりで比べられる） */
function bigrams(chars: readonly string[]): string[] {
  return chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`);
}

/** 残す文のうち、発言の中にある言葉の割合の下限 */
const MIN_GROUNDED_RATIO = 0.7;
/** 発言にない文字が続いてよい長さの上限（「は」「を」のつなぎと短い言い足しだけを許す） */
const MAX_UNGROUNDED_RUN = 4;
/** 写した発言の短さの下限（「はい」のような短い言葉で通さない） */
const MIN_QUOTE_CHARS = 4;

/** 残す文の中で、発言にない文字がいちばん長く続く長さ */
function longestUngroundedRun(chars: readonly string[], known: ReadonlySet<string>): number {
  let longest = 0;
  let run = 0;
  chars.forEach((char, index) => {
    const before = index > 0 && known.has(`${chars[index - 1]}${char}`);
    const after = index < chars.length - 1 && known.has(`${char}${chars[index + 1]}`);
    run = before || after ? 0 : run + 1;
    longest = Math.max(longest, run);
  });
  return longest;
}

/**
 * 残す文が、この発言で利用者が話したことか。quote（発言をそのまま写した部分）が発言の中にあり、
 * 残す文のほとんどの言葉が発言の中にあり、発言にない文字が長く続かないときだけ通す。
 * ページの文や見回りの結果は発言と重ならないので通らず、発言に指示を混ぜた文も通らない
 */
export function memoGroundedInMessage(text: string, quote: string, message: string): boolean {
  const said = joined(message);
  const copied = joined(quote);
  if ([...copied].length < MIN_QUOTE_CHARS || !said.includes(copied)) return false;
  const chars = [...joined(text)];
  const words = bigrams(chars);
  if (words.length === 0) return false;
  const known = new Set(bigrams([...said]));
  const overlap = words.filter((word) => known.has(word)).length;
  return (
    overlap / words.length >= MIN_GROUNDED_RATIO &&
    longestUngroundedRun(chars, known) <= MAX_UNGROUNDED_RUN
  );
}

/** 同じ内容の項目か（空白と全角・半角の違いをならす） */
export function sameMemoText(a: string, b: string): boolean {
  return joined(a) === joined(b);
}
