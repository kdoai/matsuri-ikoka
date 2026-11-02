// エージェントが Web で何を調べ、何を読んだかを控え、答えの出典が実際に読んだページかを確かめる。
// 「公式情報で確認しました」と言うには、その出典のページを読んでいる必要がある（情報の壁）。
// フックから tool_name と tool_input を渡すだけで使えるよう、SDK の型には依存しない。

export interface WebActivityLog {
  /** PostToolUse のフックから、ツールの名前と入力を渡す。WebSearch と WebFetch 以外は無視する */
  record(toolName: string, toolInput: unknown): void;
  /** 検索した語（呼んだ順） */
  readonly searches: readonly string[];
  /** 読みに行った URL（呼んだ順、重複なし） */
  readonly fetchedUrls: readonly string[];
  /** 検索はしたが、本文を1つも読んでいない */
  searchedWithoutReading(): boolean;
}

export function createWebActivityLog(): WebActivityLog {
  const searches: string[] = [];
  const fetchedUrls: string[] = [];
  return {
    record(toolName, toolInput) {
      const input = typeof toolInput === "object" && toolInput !== null ? toolInput : {};
      if (toolName === "WebSearch" && "query" in input && typeof input.query === "string") {
        searches.push(input.query.trim());
      }
      if (toolName === "WebFetch" && "url" in input && typeof input.url === "string") {
        const url = input.url.trim();
        if (!fetchedUrls.includes(url)) fetchedUrls.push(url);
      }
    },
    searches,
    fetchedUrls,
    searchedWithoutReading() {
      return searches.length > 0 && fetchedUrls.length === 0;
    },
  };
}

/**
 * 比べるための URL の形。ホストを小文字にし、スキーム・フラグメント・末尾のスラッシュを落とす。
 * http と https、末尾のスラッシュの有無で、同じページを別物と判定しないため。
 */
export function comparableUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.host}${path}${url.search}`;
}

/** 出典のうち、読みに行った URL に含まれないもの（URL のまま返す）。空なら、すべて読んだ出典 */
export function ungroundedSources(
  sources: readonly { url: string }[],
  fetchedUrls: readonly string[],
): string[] {
  const fetched = new Set(fetchedUrls.map(comparableUrl).filter((url) => url !== null));
  return sources
    .map((source) => source.url)
    .filter((url) => {
      const comparable = comparableUrl(url);
      return comparable === null || !fetched.has(comparable);
    });
}
