// ガイドの手帳に残してよい文かを、コードで確かめる（docs/spec/guide.md の「ガイドの手帳」）。
// - 現在地、体調の詳しい内容、連絡先、秘密の値は残さない
// - 残すのは利用者が話したことだけ。ページや見回りの結果の文は、発言と照らして通さない
// 見分けられなかった文は残さないほうへ倒す。残せるのは、同行者の好み・ペース・避けたいことのような短い言い方。
// 理由は種類だけを返し、文そのものをログに残さない。
// 調べ役へ渡す文（privateValueRefusal）は、言葉では断らず、値の形だけを見る（「屋台でカードは使えますか」は調べてよい）。

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
];
const HEALTH_PATTERNS = [
  /がん(?:治療|患者|検診|の|を|で)/,
  /うつ(?:病|状)/,
  // 「だけが」「おでかけが」には当てない
  /(?<![だかつづあわ])けが(?:を|し|で|が|です|人)/,
  /(?:足|脚|膝|ひざ|腰|こし|背中|肩|首|目|耳|胸|お腹|おなか|腹|頭|歯|喉|のど)(?:が|も|は)?(?:悪|弱|いた|わる|よわ|不自由|見えな|聞こえな)/,
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
/** 電話番号（区切りあり・なし）。10桁以上の数字の並び。空白ではつながない */
const PHONE = /(?:[0-9][-()]?){10,}/;
/** 空白で区切って書いた電話番号。0 から始まる3つの組 */
const SPACED_PHONE = /(?<![0-9])0[0-9]{1,4}[\s-]+[0-9]{1,4}[\s-]+[0-9]{3,4}(?![0-9])/;
/** スキームつきか、「英数字.英字2文字以上」の形の URL */
const URL_LIKE = /https?:\/\/|[a-z0-9-]+\.[a-z]{2,}/i;

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
 * 言葉では断らないので、「クレジットカードは使えますか」は通る。数字は空白をまたいでつなげないので、
 * 「2026-11-15 18:00」は電話番号にならない
 */
export function privateValueRefusal(
  text: string,
): Exclude<MemoRefusal, "health" | "not_from_user"> | null {
  const value = spaced(text);
  if (TOKEN_LIKE.test(value)) return "secret";
  if (EMAIL.test(value) || PHONE.test(value) || SPACED_PHONE.test(value)) return "contact";
  if (URL_LIKE.test(value)) return "contact";
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
  if (PHONE.test(value) || URL_LIKE.test(value)) return "contact";
  if (CONTACT_WORDS.some((word) => lower.includes(word.toLowerCase()))) return "contact";
  if (
    STAYING_AT.test(value) ||
    HERE_NOW.test(value) ||
    LOCATION_WORDS.some((word) => value.includes(word))
  ) {
    return "location";
  }
  if (
    HEALTH_PATTERNS.some((pattern) => pattern.test(value)) ||
    HEALTH_WORDS.some((word) => value.includes(word))
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
