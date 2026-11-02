import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../session/sessionStore";
import { agentConfigDir, forgetTranscripts } from "./transcripts";

describe("agentConfigDir", () => {
  it("API キーで動かすときは一時ディレクトリにし、終了時に消す", () => {
    const { dir, cleanup } = agentConfigDir({ ANTHROPIC_API_KEY: "test-key" });

    expect(dir).not.toBeNull();
    expect(path.dirname(dir!)).toBe(path.resolve(tmpdir()));
    expect(existsSync(dir!)).toBe(true);
    cleanup();
    expect(existsSync(dir!)).toBe(false);
  });

  it("ログイン済みの資格情報で動かすときは、置き場所を変えない", () => {
    expect(agentConfigDir({}).dir).toBeNull();
  });
});

describe("forgetTranscripts", () => {
  it("使われなくなった相談を消すとき、その相談の会話の記録を消す", async () => {
    const deleted: [string, string][] = [];
    let now = 0;
    const sessions = new SessionStore({
      now: () => now,
      onRemove: forgetTranscripts(async (id, { dir }) => {
        deleted.push([id, dir]);
      }, "/tmp/matsuri-agent-test"),
    });
    const talked = sessions.create();
    talked.agentSessionId = "sdk-session-1";
    sessions.create();

    now = 7 * 60 * 60 * 1000;
    sessions.sweep();

    expect(deleted).toEqual([["sdk-session-1", "/tmp/matsuri-agent-test"]]);
    expect(sessions.get(talked.id)).toBeUndefined();
  });

  it("返事を作っている途中の相談は消さない", () => {
    let now = 0;
    let removed = 0;
    const sessions = new SessionStore({ now: () => now, onRemove: () => (removed += 1) });
    const busy = sessions.create();
    busy.busy = true;

    now = 7 * 60 * 60 * 1000;
    sessions.sweep();

    expect(removed).toBe(0);
    expect(sessions.get(busy.id)).toBe(busy);
  });
});
