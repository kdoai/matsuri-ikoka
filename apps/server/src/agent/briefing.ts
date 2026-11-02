import type { ConversationStage, DateWish, Preferences } from "@matsuri-ikoka/schema";
import { arrivalBufferMinutes } from "../domain/arrivalBuffer";
import { formatMonthDay, formatMonthDayWithWeekday } from "../domain/calendar";
import { preferenceEffects } from "../domain/preferences";
import type { ToolContext } from "../tools/context";
import type { Staff } from "./bubbles";

// エージェントに渡す「店の記録」。会話の状態・条件・こだわり・候補・旅程は、サーバーが持つものを正とする。
// 利用者の発言とは、決まったタグで分けて渡す。

const STAGE_LABELS: Record<ConversationStage, string> = {
  hearing: "聞き取り",
  candidates: "祭りの候補",
  itinerary: "旅程の案",
  revising: "修正",
  verifying: "確定前の確認",
  shiori: "旅のしおり",
};

const PREFERENCE_LABELS = {
  party: { adults: "大人だけ", kids: "子連れ", seniors: "シニアと一緒" },
  spot: { classic: "定番どころ", auto: "おまかせ", hidden: "穴場" },
  food: { stalls: "屋台で十分", local: "地元の店も楽しむ" },
  move: { train: "電車", car: "車" },
} as const;

export function preferencesLabel(p: Preferences): string {
  const labels = [
    PREFERENCE_LABELS.party[p.party],
    PREFERENCE_LABELS.spot[p.spot],
    PREFERENCE_LABELS.food[p.food],
    PREFERENCE_LABELS.move[p.move],
  ].join("・");
  return `${labels}（ツールに渡す値：${JSON.stringify(p)}）`;
}

function wishLabel(wish: DateWish): string {
  return wish.kind === "date"
    ? formatMonthDayWithWeekday(wish.date)
    : `${formatMonthDayWithWeekday(wish.from)}〜${formatMonthDayWithWeekday(wish.to)}`;
}

/** 店の記録（コンシェルジュとスタッフに共通） */
export function shopRecord(ctx: ToolContext): string {
  const { session } = ctx;
  const { conditions } = session;
  const lines: string[] = [];
  lines.push(`今日：${ctx.today()}（${formatMonthDayWithWeekday(ctx.today())}）`);
  lines.push(`会話の状態：${session.stage}（${STAGE_LABELS[session.stage]}）`);

  const known = [
    conditions.when
      ? `希望日 ${wishLabel(conditions.when)}（${JSON.stringify(conditions.when)}）`
      : null,
    conditions.origin ? `出発地 ${conditions.origin}` : null,
    conditions.stay ? (conditions.stay === "day_trip" ? "日帰り" : "宿泊") : null,
    conditions.party ? `大人${conditions.party.adults}・子ども${conditions.party.children}` : null,
  ].filter((v): v is string => v !== null);
  lines.push(`聞き取れた条件：${known.length === 0 ? "まだありません" : known.join(" / ")}`);
  lines.push(`こだわり：${preferencesLabel(session.preferences)}`);

  if (session.candidates.length > 0) {
    lines.push("出した候補：");
    for (const c of session.candidates) {
      const time = c.start ? ` ${c.start}〜${c.end ?? ""}` : "";
      const confirmed = c.confirmed ? "開催確認済み" : "未確認";
      lines.push(
        `- ${c.festivalId}：${c.name} ${formatMonthDay(c.date)}${time}（${confirmed}・確度 ${c.confidence}）`,
      );
    }
  }
  if (session.selectedFestivalId) lines.push(`選んだ祭り：${session.selectedFestivalId}`);

  const itinerary = session.itineraryId ? ctx.itineraries.get(session.itineraryId) : undefined;
  if (itinerary === undefined) {
    lines.push("旅程：まだありません");
  } else {
    const verification =
      itinerary.verification.status === "pending"
        ? "再確認はまだ"
        : `再確認の結果 ${itinerary.verification.status}`;
    lines.push(
      `旅程：第${itinerary.version}版（主役 ${itinerary.mainFestivalId}、${formatMonthDay(itinerary.date)}、予定${itinerary.items.length}件、${verification}）`,
    );
  }
  return lines.join("\n");
}

const OPEN_RECORD = "<店の記録>";
const CLOSE_RECORD = "</店の記録>";
const OPEN_MESSAGE = "<お客さまの発言>";
const CLOSE_MESSAGE = "</お客さまの発言>";

/** 利用者の発言の中で、記録や発言の区切りのタグを作れないようにする */
export function sanitizeMessage(message: string): string {
  // タグの文字列だけを消すと、入れ子（</お客さまの<お客さまの発言>発言>）で消したあとにタグができる。
  // 山かっこを全角にして、発言の中ではどんなタグも作れないようにする
  return message.replaceAll("<", "＜").replaceAll(">", "＞");
}

/** コンシェルジュに渡す、1回の発言のプロンプト */
export function turnPrompt(ctx: ToolContext, message: string): string {
  return [
    OPEN_RECORD,
    shopRecord(ctx),
    CLOSE_RECORD,
    OPEN_MESSAGE,
    sanitizeMessage(message),
    CLOSE_MESSAGE,
  ].join("\n");
}

/** サブエージェントの開始時に足す文脈。旅程係には今の旅程の全体を渡す */
export function staffBriefing(ctx: ToolContext, staff: Staff): string {
  const parts = [OPEN_RECORD, shopRecord(ctx), CLOSE_RECORD];
  const rules = preferenceEffects(ctx.session.preferences).rules;
  if (staff !== "researcher") {
    parts.push(`こだわりによる組み方の決まり：\n${rules.map((r) => `- ${r}`).join("\n")}`);
  }
  if (staff === "planner") {
    const festivalId =
      (ctx.session.itineraryId
        ? ctx.itineraries.get(ctx.session.itineraryId)?.mainFestivalId
        : undefined) ?? ctx.session.selectedFestivalId;
    const festival = festivalId ? ctx.festivals.get(festivalId) : undefined;
    if (festival !== undefined) {
      parts.push(`会場への到着の余裕：開始の${arrivalBufferMinutes(festival)}分前までに着く`);
    }
    const itinerary = ctx.session.itineraryId
      ? ctx.itineraries.get(ctx.session.itineraryId)
      : undefined;
    if (itinerary !== undefined) {
      parts.push(
        `今の旅程（第${itinerary.version}版）。修正では、変えない予定の id と中身をそのまま残す：\n${JSON.stringify(itinerary)}`,
      );
    }
  }
  return parts.join("\n");
}
