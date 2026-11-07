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
 * しおりを共有する URL。接客サーバーが保存した旅程を指す。
 * サーバーは、公式の情報で開催予定を確かめた旅程だけを、しおりとして出す。
 * 旅程の ID で開けるのは、持ち主のない旅程（ログインせずに組んだ旅程）だけ
 */
export function shioriShareUrl(itineraryId: string, origin: string): string {
  return `${origin}/shiori/${encodeURIComponent(itineraryId)}`;
}

/** しおりの URL を決めるのを待つ上限（ミリ秒） */
export const SHIORI_URL_TIMEOUT_MS = 10_000;

/**
 * 開くしおりの URL を決める。自分の旅程は共有の ID で開き、そうでなければ旅程の ID で開く。
 * 失敗や時間切れは例外にする。旅程の ID で開くと、自分の旅程でも「見つかりません」と出てしまう
 */
export async function resolveShioriUrl(
  account: { ownShioriPath(itineraryId: string): Promise<string | null> } | null,
  itineraryId: string,
  origin: string,
  timeoutMs: number = SHIORI_URL_TIMEOUT_MS,
): Promise<string> {
  if (account === null) return shioriShareUrl(itineraryId, origin);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    const own = await Promise.race([account.ownShioriPath(itineraryId), expired]);
    return own === null ? shioriShareUrl(itineraryId, origin) : `${origin}${own}`;
  } finally {
    clearTimeout(timer);
  }
}
