import { z } from "zod";

// ログに残す失敗の形。発言の本文・位置・トークンをログに残さない（docs/spec/account.md の「ログ」）。
// 例外の文には、ライブラリが入力をそのまま入れることがあるので、文を残さず、種類と場所だけを残す。

/** スタックのうち、残す行の数 */
const MAX_FRAMES = 8;

export interface LoggedError {
  errorName: string;
  /** Firestore などの失敗の種類（あれば） */
  errorCode?: string | number;
  /** スキーマの不一致なら、どの項目がどう違ったか（値は入れない） */
  issues?: string[];
  /** どこで起きたか。1行目（例外の文）は除く */
  frames?: string[];
}

export function errorForLog(error: unknown): LoggedError {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = (error as { code?: unknown }).code;
  const frames = error.stack
    ?.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, MAX_FRAMES);
  return {
    errorName: error.name,
    ...(typeof code === "string" || typeof code === "number" ? { errorCode: code } : {}),
    ...(error instanceof z.ZodError
      ? { issues: error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`) }
      : {}),
    ...(frames === undefined || frames.length === 0 ? {} : { frames }),
  };
}
