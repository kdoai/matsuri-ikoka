import {
  type GuideMemoItem,
  type GuideResumeSummary,
  type IsoDate,
  type Itinerary,
  type LatLng,
  mainFestivalDay,
  tripPhase,
} from "@matsuri-ikoka/schema";
import { sanitizeMessage } from "../agent/briefing";

// ガイドに渡す、1回の発言のプロンプト。変わらない決まりは system prompt（prompts/guide.md）に置き、
// 旅のようす・手帳・現在地・発言はここに入れる。外から来た文字列はタグで分け、中の山かっこを全角にして、
// タグを作らせない。旅の ID や利用者の ID は渡さない（ツールの入力に書けないように）。

const PHASE_LABELS = {
  before: "出発の前",
  during: "旅の間",
  after: "旅のあと",
} as const;

export function guideTurnPrompt(input: {
  itinerary: Itinerary;
  today: IsoDate;
  now: string;
  memo: readonly GuideMemoItem[];
  unreadNotices: number;
  pendingProposals: number;
  /** 新しい会話で続けるときの、コードが書いた要約。会話を続けるときは渡さない */
  resume?: GuideResumeSummary | undefined;
  location?: LatLng | undefined;
  emergency: boolean;
  message: string;
}): string {
  const { itinerary } = input;
  const first = itinerary.days[0]?.date;
  const last = itinerary.days.at(-1)?.date;
  const record = [
    `今の日時：${input.now}（今日は ${input.today}）`,
    `旅の時期：${PHASE_LABELS[tripPhase(itinerary, input.today)]}`,
    `旅：${sanitizeMessage(itinerary.title)}（${first}〜${last}、第${itinerary.version}版、主役の祭りの日は ${mainFestivalDay(itinerary).date}）`,
    `未読の通知：${input.unreadNotices}件、承認を待っている案：${input.pendingProposals}件`,
  ];
  if (input.resume !== undefined && input.resume.turns > 0) {
    record.push(
      `これまでの会話の文は手元にありません。${input.resume.turns}回話しました（話題：${input.resume.topics.join("・") || "なし"}）。覚えているふりをせず、要るものはツールで読み直してください`,
    );
  }
  if (input.location !== undefined) {
    record.push(
      `利用者の現在地（この発言のときだけ使う。手帳に残さない。座標は調べる文に入れず、調べるときは駅や場所の名前で渡す）：緯度 ${input.location.lat}、経度 ${input.location.lng}`,
    );
  }
  if (input.emergency) {
    record.push(
      "この発言には緊急かもしれない言葉があります。公的な連絡先（119・110）は画面に出してあります。診断も判断もしないでください",
    );
  }
  const memo = input.memo.map((item) => `- ${sanitizeMessage(item.text)}`);
  return [
    "<旅の記録>",
    ...record,
    "</旅の記録>",
    "<手帳>",
    ...(memo.length > 0 ? memo : ["（まだ何もありません）"]),
    "</手帳>",
    "<利用者の発言>",
    sanitizeMessage(input.message),
    "</利用者の発言>",
  ].join("\n");
}
