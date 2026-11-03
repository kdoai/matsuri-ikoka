import {
  type DateWish,
  DateWishSchema,
  type Preferences,
  PreferencesSchema,
  type StaffId,
  type ToolName,
  type VerificationResult,
} from "@matsuri-ikoka/schema";
import { formatMonthDay } from "../domain/calendar";

// 吹き出しの文章。サーバーがツールの入力と結果から決まった型で作り、モデルには書かせない。
// 入力の形が崩れていても、決まった文に戻す。

export const STAFF_TASK = {
  researcher: "find_festivals",
  scout: "find_nearby",
  planner: "plan_route",
} as const;

export type Staff = keyof typeof STAFF_TASK;

export function staffStartBubble(staff: Staff, options: { hasItinerary: boolean }): string {
  switch (staff) {
    case "researcher":
      return "調べてきますね";
    case "scout":
      return "寄り道を探してきます";
    case "planner":
      return options.hasItinerary ? "組み直します" : "道のりを調べます";
  }
}

function wishLabel(wish: DateWish): string {
  if (wish.kind === "date") return formatMonthDay(wish.date);
  return wish.from === wish.to
    ? formatMonthDay(wish.from)
    : `${formatMonthDay(wish.from)}から${formatMonthDay(wish.to)}`;
}

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object"
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

/** search_nearby の吹き出しの「何を探すか」 */
function nearbyTargets(preferences: Preferences): string {
  const parts: string[] = [];
  if (preferences.food === "local") parts.push("地元の味");
  if (preferences.party === "kids") parts.push("子どもと楽しめる場所");
  else if (preferences.party === "seniors") parts.push("座って休める場所");
  if (preferences.spot === "hidden") parts.push("人の少ない場所");
  else if (preferences.spot === "classic") parts.push("定番の場所");
  return parts.length === 0 ? "寄れる場所" : parts.join("と");
}

export function toolStartBubble(
  tool: ToolName,
  input: unknown,
  state: { preferences: Preferences; hasItinerary: boolean },
): string {
  switch (tool) {
    case "search_festivals": {
      const wish = DateWishSchema.safeParse(field(input, "when"));
      const origin = field(input, "origin");
      const nights = field(input, "nights");
      const stay =
        nights === 0 ? "日帰りで" : typeof nights === "number" && nights > 0 ? `${nights}泊で` : "";
      if (!wish.success || typeof origin !== "string" || origin.trim() === "") {
        return "条件に合う祭りを探しています";
      }
      return `${wishLabel(wish.data)}に、${origin.trim().slice(0, 20)}から${stay}行ける祭りを探しています`;
    }
    case "search_nearby": {
      const given = PreferencesSchema.safeParse(field(input, "preferences"));
      return `会場の近くで、${nearbyTargets(given.success ? given.data : state.preferences)}を探しています`;
    }
    case "get_access": {
      const move = field(input, "move") ?? state.preferences.move;
      return move === "car"
        ? "車の道のりと駐車場を確かめています"
        : "電車の所要時間を確かめています";
    }
    case "get_weather": {
      const date = field(input, "date");
      return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? `${formatMonthDay(date)}の天気を確かめています`
        : "当日の天気を確かめています";
    }
    case "update_itinerary":
      return state.hasItinerary ? "旅程を書き直しています" : "旅程を書き込んでいます";
    case "verify_festival":
      return "開催予定を公式情報で確かめています";
  }
}

const VERIFIED_BUBBLES: Record<VerificationResult, string> = {
  as_planned: "開催予定を公式情報で確認しました",
  changed: "開催の内容に変更がありました",
  cancelled: "中止が発表されていました",
  not_found: "公式情報では確かめられませんでした",
};

export const FAILED_BUBBLE = "うまく調べられませんでした";

/** ツールの後の吹き出しと件数。output は失敗のとき null */
export function toolEndBubble(
  tool: ToolName,
  output: Record<string, unknown> | null,
): { ok: boolean; bubble: string; count: number | null } {
  if (output === null) return { ok: false, bubble: FAILED_BUBBLE, count: null };
  switch (tool) {
    case "search_festivals": {
      const count = Array.isArray(output.candidates) ? output.candidates.length : 0;
      return {
        ok: true,
        bubble: count === 0 ? "条件に合う祭りが見つかりませんでした" : `${count}件見つかりました`,
        count,
      };
    }
    case "search_nearby": {
      const count = Array.isArray(output.spots) ? output.spots.length : 0;
      return {
        ok: true,
        bubble: count === 0 ? "寄れる場所が見つかりませんでした" : `${count}か所見つかりました`,
        count,
      };
    }
    case "get_access":
      return { ok: true, bubble: "所要時間を確かめました", count: null };
    case "get_weather": {
      const status = field(output.weather, "status");
      const bubble =
        status === "forecast"
          ? "予報を確かめました"
          : status === "not_yet"
            ? "まだ予報が出ていない日でした"
            : "予報を取得できませんでした";
      return { ok: true, bubble, count: null };
    }
    case "update_itinerary": {
      if (output.saved !== true) {
        return output.unchanged === true
          ? { ok: true, bubble: "旅程はそのままです", count: null }
          : { ok: false, bubble: "旅程に直すところがありました", count: null };
      }
      const first = field(output.diff, "fromVersion") === 0;
      return { ok: true, bubble: first ? "旅程ができました" : "旅程を直しました", count: null };
    }
    case "verify_festival": {
      const result = output.result as VerificationResult;
      // 「公式情報で確認」と言うのは、公式の出典があるときだけ
      const official =
        Array.isArray(output.sources) &&
        output.sources.some((s) => field(s, "confidence") === "official");
      const bubble =
        result === "as_planned" && !official
          ? "開催予定を確かめました"
          : (VERIFIED_BUBBLES[result] ?? FAILED_BUBBLE);
      return { ok: true, bubble, count: null };
    }
  }
}

export function isStaff(value: unknown): value is Staff {
  return value === "researcher" || value === "scout" || value === "planner";
}

/** フックの agent_type（サブエージェントの名前）から、スタッフを決める。本体はコンシェルジュ */
export function staffOf(agentType: string | undefined): StaffId | null {
  if (agentType === undefined || agentType === "") return "concierge";
  return isStaff(agentType) ? agentType : null;
}
