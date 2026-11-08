// この端末だけで覚えておく、画面の小さな設定。読み書きできない環境（プライベートな窓など）では覚えない。

import { SessionIdSchema } from "@matsuri-ikoka/schema";
import type { SessionMemory } from "../state/store";
import { type CandidateView, parseCandidateView } from "./candidates/view";

const TUTORIAL_KEY = "matsuri-ikoka:tutorial-seen";

/** はじめての操作の案内を、前に見終えているか */
export function loadTutorialSeen(): boolean {
  try {
    return window.localStorage.getItem(TUTORIAL_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveTutorialSeen(): void {
  try {
    window.localStorage.setItem(TUTORIAL_KEY, "1");
  } catch {
    // 覚えられなくても、次に来たときにもう一度出すだけ
  }
}

const CANDIDATE_VIEW_KEY = "matsuri-ikoka:candidate-view";

/** 祭りの候補を、前にどの表示（カード・リスト）で見ていたか */
export function loadCandidateView(): CandidateView {
  try {
    return parseCandidateView(window.localStorage.getItem(CANDIDATE_VIEW_KEY));
  } catch {
    return "cards";
  }
}

export function saveCandidateView(view: CandidateView): void {
  try {
    window.localStorage.setItem(CANDIDATE_VIEW_KEY, view);
  } catch {
    // 覚えられなくても、次はカード表示から始まるだけ
  }
}

const SESSION_KEY = "matsuri-ikoka:session";

/**
 * いまの相談の ID を、この端末に控える。再読み込みやタブの破棄のあとに、相談の続きを開く。
 * 控えるのは推測できない相談の ID だけで、会話の文章は控えない。持ち主の確かめはサーバーが行う
 */
export const sessionMemory: SessionMemory = {
  load() {
    try {
      const value = window.localStorage.getItem(SESSION_KEY);
      return value !== null && SessionIdSchema.safeParse(value).success ? value : null;
    } catch {
      return null;
    }
  },
  save(sessionId) {
    try {
      if (sessionId === null) window.localStorage.removeItem(SESSION_KEY);
      else window.localStorage.setItem(SESSION_KEY, sessionId);
    } catch {
      // 控えられなくても、再読み込みのあとに新しい相談から始まるだけ
    }
  },
};

const VOICE_INPUT_KEY = "matsuri-ikoka:voice-input-accepted";

/** 声の入力の説明を読んで、使うと決めたか */
export function loadVoiceInputAccepted(): boolean {
  try {
    return window.localStorage.getItem(VOICE_INPUT_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveVoiceInputAccepted(): void {
  try {
    window.localStorage.setItem(VOICE_INPUT_KEY, "1");
  } catch {
    // 覚えられなくても、次に使うときにもう一度説明するだけ
  }
}
