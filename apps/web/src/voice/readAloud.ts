import type { DialogueLine } from "../state/selectors";
import { continuationText, type Speaker } from "./speak";

// どの文を、いつ読み上げるか。画面の部品から切り離して、テストで確かめられるようにする。

/** いま読み上げる文。key が変わったときだけ読み直す */
export interface SpokenLine {
  key: string;
  text: string;
}

/**
 * 会話の窓で読む文。窓に出ている文と同じにする。
 * 窓を閉じている間、考えている間の入れ替わるひとこと、作業の様子、流れてくる途中の返事は読まない（null）
 */
export function dialogueSpokenLine(input: {
  /** 会話の窓が開いているか */
  open: boolean;
  /** 選んで進める相談の問い。相談の間でなければ null */
  consult: string | null;
  line: DialogueLine;
  /** 会話の窓に出ているセリフの頭（1〜2文）と、「つづきを読む」を開いているか */
  head: string;
  expanded: boolean;
  /** 窓に出ている、あいさつかエラーの文 */
  text: string;
}): SpokenLine | null {
  if (!input.open) return null;
  if (input.consult !== null) return { key: `consult:${input.consult}`, text: input.consult };
  const { line } = input;
  switch (line.kind) {
    case "greeting":
      return { key: "greeting", text: input.text };
    case "error":
      return { key: `error:${line.entry.id}`, text: input.text };
    case "concierge":
      if (line.streaming) return null;
      return input.expanded
        ? { key: `${line.id}:rest`, text: continuationText(input.head, line.text) }
        : { key: `${line.id}:head`, text: input.head };
    case "waiting":
    case "work":
      return null;
  }
}

export interface ReadAloudState {
  /** 読み上げがオンか */
  enabled: boolean;
  /** 声の入力で聞いている間か */
  listening: boolean;
  line: SpokenLine | null;
  lang: string;
}

/**
 * 読み上げの進め方。文が変わったら前の読み上げを止めて読む。
 * 聞いている間は読み上げの声をマイクが拾わないよう黙り、聞き終えてから、まだ読んでいない文を読む。
 * 読む文がない間（窓を閉じたとき・考えている間）と、オフにしたときは止める
 */
export function createReadAloud(speaker: Speaker) {
  let spoken: string | null = null;
  return {
    update(state: ReadAloudState): void {
      if (!state.enabled || state.line === null || state.line.text.trim() === "") {
        speaker.stop();
        spoken = null;
        return;
      }
      if (state.listening) {
        speaker.stop();
        return;
      }
      const key = `${state.lang}:${state.line.key}`;
      if (key === spoken) return;
      spoken = key;
      speaker.say(state.line.text, state.lang);
    },
    /** 窓が消えたとき */
    stop(): void {
      speaker.stop();
      spoken = null;
    },
  };
}
