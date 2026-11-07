import { EMERGENCY_CONTACTS, type GuideSseEventOf } from "@matsuri-ikoka/schema";

// 緊急の相談を、発言の言葉からコードで見分ける（docs/spec/guide.md の「話せること・できないこと」）。
// モデルを待たずに公的な連絡先を出すためのもので、診断や判断はしない。
// 緊急でない発言に当たっても、連絡先の案内が1つ増えるだけで、ガイドはそのまま答える。

/** 体の急変・大きなけが */
const BODY_WORDS = [
  "倒れ",
  "意識",
  "呼吸",
  "息ができ",
  "息をして",
  "息が苦し",
  "胸が痛",
  "胸の痛み",
  "けいれん",
  "痙攣",
  "出血",
  "血が止ま",
  "骨折",
  "頭を打",
  "やけど",
  "火傷",
  "熱中症",
  "アナフィラキシー",
  "救急",
  "動けな",
  "溺れ",
];

/** 事故・事件・災害 */
const INCIDENT_WORDS = [
  "事故",
  "火事",
  "火災",
  "警察",
  "襲われ",
  "暴行",
  "刺され",
  "痴漢",
  "ストーカー",
  "つけられて",
  "誘拐",
  "行方不明",
  "いなくなっ",
  "地震",
  "津波",
  "避難",
];

/** 119 番・110 番。金額や品番の一部（1190円など）には当てない */
const EMERGENCY_NUMBERS = /(?<![0-9])(?:119|110)(?![0-9])/;

/** 全角の数字やかなの揺れをならす */
function normalized(message: string): string {
  return message.normalize("NFKC").replaceAll(/\s+/g, "");
}

/** 発言に、緊急かもしれない言葉があるか */
export function isEmergencyMessage(message: string): boolean {
  const text = normalized(message);
  if (EMERGENCY_NUMBERS.test(text)) return true;
  return [...BODY_WORDS, ...INCIDENT_WORDS].some((word) => text.includes(word));
}

/** 公的な連絡先のイベント。返答の文より先に送る */
export function emergencyEvent(): GuideSseEventOf<"guide.emergency"> {
  return { type: "guide.emergency", data: { contacts: [...EMERGENCY_CONTACTS] } };
}

/** モデルの返事を作れないときに、連絡先に添える決まった文 */
export const EMERGENCY_FALLBACK_TEXT =
  "命にかかわるかもしれないときは、すぐに 119（救急・火事）か 110（警察）に電話してください。わたしには診断も判断もできません。電話の案内に従ってください。";
