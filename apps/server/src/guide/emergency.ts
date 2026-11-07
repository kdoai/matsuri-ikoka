import { EMERGENCY_CONTACTS, type GuideSseEventOf } from "@matsuri-ikoka/schema";

// 緊急の相談を、発言の言葉からコードで見分ける（docs/spec/guide.md の「話せること・できないこと」）。
// モデルを待たずに公的な連絡先を出すためのもので、診断や判断はしない。
// 緊急でない発言に当たっても、連絡先の案内が1つ増えるだけで、ガイドはそのまま答える。
// 見逃しの害のほうが大きいので、広く取る。

/** 体の急変・大きなけが（漢字とかな） */
const BODY_WORDS = [
  "倒れ",
  "たおれ",
  "意識",
  "いしき",
  "気を失",
  "きをうしな",
  "失神",
  "呼吸",
  "こきゅう",
  "息ができ",
  "いきができ",
  "息をして",
  "苦し",
  "くるし",
  "胸が痛",
  "胸の痛み",
  "激痛",
  "痛みがひど",
  "痛くて",
  "けいれん",
  "痙攣",
  "出血",
  "血が",
  "ちがで",
  "ちがとま",
  "血まみれ",
  "吐血",
  "骨折",
  "こっせつ",
  "頭を打",
  "あたまをう",
  "やけど",
  "火傷",
  "熱中症",
  "ねっちゅうしょう",
  "高熱",
  "アナフィラキシー",
  "救急",
  "きゅうきゅう",
  "動けな",
  "うごけな",
  "立てな",
  "立てま",
  "たてな",
  "たてま",
  "溺れ",
  "おぼれ",
  "怪我",
  "ケガ",
  "具合が悪",
  "ぐあいがわる",
  "気分が悪",
  "きぶんがわる",
  "体調が悪",
  "たいちょうがわる",
  "吐い",
  "吐き",
  "はきそう",
  "嘔吐",
  "ぐったり",
  "刺され",
  "さされ",
];

/** 事故・事件・災害・命にかかわること */
const INCIDENT_WORDS = [
  "事故",
  "火事",
  "火災",
  "警察",
  "けいさつ",
  "襲われ",
  "おそわれ",
  "殴られ",
  "なぐられ",
  "蹴られ",
  "けられ",
  "暴行",
  "脅され",
  "おどされ",
  "痴漢",
  "ちかん",
  "ストーカー",
  "つけられて",
  "盗まれ",
  "ぬすまれ",
  "ひったくり",
  "誘拐",
  "行方不明",
  "いなくなっ",
  "地震",
  "津波",
  "避難",
  "助けて",
  "たすけて",
  "死にたい",
  "しにたい",
  "死にそう",
  "しにそう",
  "自殺",
  "じさつ",
  "消えたい",
  "きえたい",
];

/** 短いかな書きは、ほかの言葉の一部に当たりやすいので、形で見る */
const KANA_PATTERNS = [
  // 「だけが」「おでかけが」には当てない
  /(?<![だかつづあわ])けが(?:を|し|で|が|です|人)/,
  /大けが/,
  /じこ(?:に|で|が|です|を)/,
  /かじ(?:です|だ|が起)/,
  /(?:子|こ|子ども|子供|こども|息子|娘)が(?:迷子|まいご)/,
];

/** 119 番・110 番。金額や品番の一部（1190円など）には当てない */
const EMERGENCY_NUMBERS = /(?<![0-9])(?:119|110)(?![0-9])/;

/** 英語の言い方。語の切れ目で見る（fireworks に fire は当てない） */
const ENGLISH =
  /\b(?:help|sos|emergency|ambulance|police|unconscious|collapsed?|faint(?:ed|ing)?|bleeding|injured|hurt|accident|heart attack|stroke|seizure|can'?t breathe|cannot breathe|not breathing|choking|attacked|assaulted|robbed|stolen|suicide|kill myself|want to die|fire|drowning|overdose|lost child|missing child)\b/;

/** 全角の数字やかなの揺れをならす。英語の語の切れ目を見るので、空白は残す */
function spaced(message: string): string {
  return message.normalize("NFKC").toLowerCase();
}

/** 発言に、緊急かもしれない言葉があるか */
export function isEmergencyMessage(message: string): boolean {
  const value = spaced(message);
  if (ENGLISH.test(value)) return true;
  const text = value.replaceAll(/\s+/g, "");
  if (EMERGENCY_NUMBERS.test(text)) return true;
  if (KANA_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return [...BODY_WORDS, ...INCIDENT_WORDS].some((word) => text.includes(word.toLowerCase()));
}

/** 公的な連絡先のイベント。返答の文より先に送る */
export function emergencyEvent(): GuideSseEventOf<"guide.emergency"> {
  return { type: "guide.emergency", data: { contacts: [...EMERGENCY_CONTACTS] } };
}

/** モデルの返事を作れないときに、連絡先に添える決まった文 */
export const EMERGENCY_FALLBACK_TEXT =
  "命にかかわるかもしれないときは、すぐに 119（救急・火事）か 110（警察）に電話してください。わたしには診断も判断もできません。電話の案内に従ってください。";
