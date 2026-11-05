// この端末だけで覚えておく、画面の小さな設定。読み書きできない環境（プライベートな窓など）では覚えない。

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
