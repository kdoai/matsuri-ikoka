import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Session } from "../session/sessionStore";

// 接客エージェントの会話の記録（Agent SDK のセッションの transcript）の置き場所と消し方
// （docs/spec/agent-runtime.md の「会話の続き」）。
// 会話は resume で続けるので記録は残すが、置き場所を一時ディレクトリにし、相談が消えたら消す。

/**
 * API キーで動かすときは、Claude Code の設定と会話の記録の置き場所（CLAUDE_CONFIG_DIR）を
 * 一時ディレクトリにする。手元でログイン済みの資格情報を使うときは、資格情報が既定の置き場所に
 * あるので動かさない（その場合も、相談が消えたら記録は消す）。
 * 戻り値の cleanup は、サーバーの終了時に一時ディレクトリを消す
 */
export function agentConfigDir(env: NodeJS.ProcessEnv): {
  dir: string | null;
  cleanup: () => void;
} {
  if (!env.ANTHROPIC_API_KEY) return { dir: null, cleanup: () => {} };
  const dir = mkdtempSync(path.join(tmpdir(), "matsuri-agent-config-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export type DeleteSession = (sessionId: string, options: { dir: string }) => Promise<void>;

/** 会話の記録を1つ消す関数を作る。cwd はエージェントの作業ディレクトリ */
export function forgetTranscript(deleteSession: DeleteSession, cwd: string) {
  return (id: string): void => {
    deleteSession(id, { dir: cwd }).catch((error: unknown) => {
      // 記録がまだない（一度も話していない）ときも失敗になるので、ログだけにする
      console.warn(
        JSON.stringify({ kind: "transcript_delete_failed", reason: String(error).slice(0, 120) }),
      );
    });
  };
}

/** 相談が消えたときに、その相談の会話の記録を消す関数を作る。cwd はエージェントの作業ディレクトリ */
export function forgetTranscripts(deleteSession: DeleteSession, cwd: string) {
  const forget = forgetTranscript(deleteSession, cwd);
  return (session: Session): void => {
    for (const id of [session.agentSessionId, session.guide.agentSessionId]) {
      if (id !== null) forget(id);
    }
  };
}
