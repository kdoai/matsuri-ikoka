// この端末だけで覚えておく、画面の小さな設定。読み書きできない環境（プライベートな窓など）では覚えない。

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
