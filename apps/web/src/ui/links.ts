// 祭りの情報の訂正と掲載停止は、公開している Issue のテンプレートで受け付ける。

export const REPOSITORY_URL = "https://github.com/kdoai/matsuri-ikoka";

type IssueTemplate = "festival-correction.yml" | "festival-opt-out.yml";

/** Issue のテンプレートを、祭りの名前を入れた状態で開くリンク */
export function issueUrl(template: IssueTemplate, title: string, festival: string): string {
  const params = new URLSearchParams({ template, title, festival });
  return `${REPOSITORY_URL}/issues/new?${params.toString()}`;
}

/** 出典のリンクに出す短い名前（タイトルがなければ、ドメインとパス） */
export function sourceLabel(source: { url: string; title?: string }): string {
  if (source.title !== undefined) {
    return source.title;
  }
  try {
    const url = new URL(source.url);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return source.url;
  }
}

/**
 * しおりを共有する URL。接客サーバーが旅程を保存しているときだけ作れる（画面だけのモックでは null）。
 * サーバーは、公式の情報で開催予定を確かめた旅程だけを、しおりとして出す。
 */
export function shioriShareUrl(
  transport: "mock" | "server",
  itineraryId: string,
  origin: string,
): string | null {
  return transport === "server" ? `${origin}/shiori/${encodeURIComponent(itineraryId)}` : null;
}
