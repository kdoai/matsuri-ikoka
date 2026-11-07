import type { GuideToolName } from "@matsuri-ikoka/schema";

// ガイドの吹き出しの文章。サーバーが決まった型から作り、モデルには書かせない（docs/spec/guide.md の「SSE イベント」）。

const START_BUBBLES: Record<GuideToolName, string> = {
  read_trip: "旅程を見ています",
  list_notices: "知らせを見ています",
  research_web: "調べています",
  get_weather: "天気を確かめています",
  research_route: "行き方を調べています",
  search_nearby: "周りを探しています",
  propose_change: "案を作っています",
  save_memo: "手帳に書いています",
};

export function guideToolStartBubble(tool: GuideToolName): string {
  return START_BUBBLES[tool];
}

const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/** ツールの結果から、終わったときの吹き出しを作る。output が null なら失敗 */
export function guideToolEnd(
  tool: GuideToolName,
  output: Record<string, unknown> | null,
): { ok: boolean; bubble: string } {
  if (output === null) return { ok: false, bubble: "うまく確かめられませんでした" };
  switch (tool) {
    case "read_trip":
      return { ok: true, bubble: "旅程を見ました" };
    case "list_notices": {
      const unread = typeof output.unread === "number" ? output.unread : 0;
      return {
        ok: true,
        bubble: unread > 0 ? `知らせが${unread}件あります` : "新しい知らせはありません",
      };
    }
    case "research_web":
      return output.status === "found"
        ? { ok: true, bubble: "調べました" }
        : { ok: false, bubble: "調べても分かりませんでした" };
    case "get_weather":
      return { ok: true, bubble: "天気を確かめました" };
    case "research_route":
      return { ok: true, bubble: "行き方を確かめました" };
    case "search_nearby": {
      const spots = count(output.spots);
      return {
        ok: true,
        bubble: spots > 0 ? `${spots}か所見つけました` : "近くには見つかりませんでした",
      };
    }
    case "propose_change":
      return output.proposed === true
        ? { ok: true, bubble: "案を作りました" }
        : { ok: false, bubble: "案を作れませんでした" };
    case "save_memo":
      return output.saved === true
        ? { ok: true, bubble: "手帳に書きました" }
        : { ok: false, bubble: "手帳には残しませんでした" };
  }
}
