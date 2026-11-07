// ガイドの手帳に残してよい文かを、コードで確かめる（docs/spec/guide.md の「ガイドの手帳」）。
// - 現在地、体調の詳しい内容、連絡先、秘密の値は残さない
// - 残すのは利用者が話したことだけ。ページや見回りの結果の文は、発言と照らして通さない
// 見分けられなかった文は残さないほうへ倒す。理由は種類だけを返し、文そのものをログに残さない。

export type MemoRefusal = "location" | "health" | "contact" | "secret" | "not_from_user";

const REFUSAL_MESSAGES: Record<MemoRefusal, string> = {
  location: "現在地や住まいの場所は、手帳に残しません",
  health:
    "体調の詳しい内容は、手帳に残しません（「ゆっくり歩く」「そばは避ける」のように書けます）",
  contact: "連絡先は、手帳に残しません",
  secret: "秘密の値は、手帳に残しません",
  not_from_user: "利用者がこの発言で話したことだけを、手帳に残せます",
};

export function memoRefusalMessage(refusal: MemoRefusal): string {
  return REFUSAL_MESSAGES[refusal];
}

const LOCATION_WORDS = [
  "現在地",
  "今いる",
  "いまいる",
  "緯度",
  "経度",
  "住所",
  "自宅",
  "ホテルの部屋",
  "部屋番号",
];
const COORDINATES = /[0-9]{1,3}\.[0-9]{3,}/;
/** 「今は○○駅にいる」のような、いまの居場所の言い方 */
const HERE_NOW = /(?:今|いま)[^。、]{0,20}(?:にいる|にいます|の近く|付近)/;

const HEALTH_WORDS = [
  "持病",
  "病気",
  "症状",
  "診断",
  "通院",
  "入院",
  "手術",
  "妊娠",
  "妊婦",
  "障害",
  "発作",
  "糖尿",
  "血圧",
  "心臓",
  "喘息",
  "ぜんそく",
  "アレルギー",
  "発熱",
  "熱がある",
  "骨折",
  "怪我",
  "ケガ",
  "腹痛",
  "頭痛",
  "めまい",
  "薬",
  "服用",
  "癌",
];

const CONTACT_WORDS = ["電話", "連絡先", "メール", "LINE", "インスタ", "アカウント"];
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** 電話番号（ハイフンあり・なし）。10桁以上の数字の並び */
const PHONE = /(?:[0-9][-()]?){10,}/;
const URL_LIKE = /https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|jp|io)\b/i;

const SECRET_WORDS = [
  "パスワード",
  "暗証",
  "合言葉",
  "クレジット",
  "カード番号",
  "口座",
  "マイナンバー",
  "パスポート",
  "トークン",
  "APIキー",
  "password",
  "secret",
];
/** 鍵やトークンに見える、英字と数字の混ざった長い文字列 */
const TOKEN_LIKE = /(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,}/;

function normalized(text: string): string {
  return text.normalize("NFKC").replaceAll(/\s+/g, "");
}

/**
 * 文の中に、連絡先・URL・座標・秘密の値が入っているか。入っていなければ null。
 * Web の調べ役へ渡す文でも同じものを確かめる（調べ役に利用者の情報を持たせず、外へ送らせないため）
 */
export function privateValueRefusal(
  text: string,
): Exclude<MemoRefusal, "health" | "not_from_user"> | null {
  const value = normalized(text);
  const lower = value.toLowerCase();
  if (SECRET_WORDS.some((word) => lower.includes(word.toLowerCase()))) return "secret";
  if (TOKEN_LIKE.test(value)) return "secret";
  if (EMAIL.test(value) || PHONE.test(value) || URL_LIKE.test(value)) return "contact";
  if (COORDINATES.test(value)) return "location";
  return null;
}

/** 手帳に残さない内容か。残してよければ null */
export function memoContentRefusal(text: string): MemoRefusal | null {
  const found = privateValueRefusal(text);
  if (found !== null) return found;
  const value = normalized(text);
  const lower = value.toLowerCase();
  if (CONTACT_WORDS.some((word) => lower.includes(word.toLowerCase()))) return "contact";
  if (HERE_NOW.test(value) || LOCATION_WORDS.some((word) => value.includes(word))) {
    return "location";
  }
  if (HEALTH_WORDS.some((word) => value.includes(word))) return "health";
  return null;
}

/** 2文字ずつの並びの集まり（日本語の言い換えでも、同じ言葉の重なりで比べられる） */
function bigrams(text: string): Set<string> {
  const chars = [...normalized(text)];
  return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
}

/** 残す文のうち、発言の中にある言葉の割合の下限 */
const MIN_GROUNDED_RATIO = 0.4;
/** 写した発言の短さの下限（「はい」のような短い言葉で通さない） */
const MIN_QUOTE_CHARS = 4;

/**
 * 残す文が、この発言で利用者が話したことか。quote（発言をそのまま写した部分）が発言の中にあり、
 * 残す文の言葉の多くが発言の中にあるときだけ通す。ページの文や見回りの結果は、発言と重ならないので通らない
 */
export function memoGroundedInMessage(text: string, quote: string, message: string): boolean {
  const said = normalized(message);
  const copied = normalized(quote);
  if ([...copied].length < MIN_QUOTE_CHARS || !said.includes(copied)) return false;
  const words = bigrams(text);
  if (words.size === 0) return false;
  const known = bigrams(said);
  const overlap = [...words].filter((word) => known.has(word)).length;
  return overlap / words.size >= MIN_GROUNDED_RATIO;
}

/** 同じ内容の項目か（空白と全角・半角の違いをならす） */
export function sameMemoText(a: string, b: string): boolean {
  return normalized(a) === normalized(b);
}
