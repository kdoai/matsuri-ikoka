// 声で話すボタンの押し方。画面の部品から切り離して、テストで確かめられるようにする。
// - 長く押したとき：押している間だけ聞き、離したら止める
// - 短く押したとき（ダブルタップのように、押してすぐ離れるとき）：聞き続け、次に押したら止める
// - click だけが届くとき（スクリーンリーダーの決定など）：押すたびに聞く・止めるを切り替える

/** これより短く押して離したときは、離しても止めず、次に押すまで聞き続ける */
export const TAP_MS = 300;

export type PressSource = "pointer" | "key";

export interface PressDeps {
  now(): number;
  /** 声の入力の説明を読んで、使うと決めたか */
  accepted(): boolean;
  /** 使う前の説明を出す */
  showNotice(): void;
  /** 聞き始める。始めたら true */
  start(): boolean;
  stop(): void;
  listening(): boolean;
  /** 聞き始めたとき（読み上げを止め、聞いている表示にする） */
  started(): void;
  /** 聞き取った文を入れた入力欄へ焦点を移す */
  focusInput(): void;
  /** 押下に続いて届く click を見分けるあいだ待つ（ふだんは次の処理の番まで） */
  defer(callback: () => void): void;
}

export interface PressControl {
  down(source: PressSource): void;
  up(source: PressSource): void;
  click(): void;
  /** ボタンから焦点が外れたとき */
  blur(): void;
  /** 聞き取った文を下書きに入れたとき */
  filled(): void;
  /** 聞き取りが終わったとき（文が入った・失敗した・やめた） */
  ended(): void;
}

export function createPressControl(deps: PressDeps): PressControl {
  /** いま押されているもの */
  let held: PressSource | null = null;
  let downAt = 0;
  /** 聞いているあいだの止め方。hold は離したら止める、toggle は次に押したら止める */
  let mode: "idle" | "hold" | "toggle" = "idle";
  /** 押下に続いて届く click を、別の押し直しと取り違えない */
  let fromPress = false;
  /** キーやボタンを押している間に文が入ったら、離してから入力欄へ移る */
  let focusPending = false;

  const release = () => {
    deps.defer(() => {
      fromPress = false;
    });
  };
  const begin = (next: "hold" | "toggle"): boolean => {
    if (!deps.accepted()) {
      deps.showNotice();
      return false;
    }
    if (!deps.start()) return false;
    mode = next;
    deps.started();
    return true;
  };
  const finish = () => {
    deps.stop();
    mode = "idle";
  };

  return {
    down(source) {
      if (held !== null) return;
      fromPress = true;
      if (mode !== "idle" && deps.listening()) {
        // 短く押して聞き続けているところを、もう一度押して止める
        held = source;
        finish();
        return;
      }
      if (!begin("hold")) {
        // 説明を出したときなどは焦点が移り、離したことが届かないので、ここで押し終えたことにする
        release();
        return;
      }
      held = source;
      downAt = deps.now();
    },
    up(source) {
      if (held !== source) return;
      held = null;
      release();
      if (mode === "hold") {
        if (deps.now() - downAt < TAP_MS) mode = "toggle";
        else finish();
      }
      if (focusPending) {
        focusPending = false;
        deps.focusInput();
      }
    },
    click() {
      if (fromPress) return;
      if (mode !== "idle" && deps.listening()) finish();
      else begin("toggle");
    },
    blur() {
      if (deps.listening()) finish();
      mode = "idle";
      held = null;
      focusPending = false;
      release();
    },
    filled() {
      if (held !== null) focusPending = true;
      else deps.focusInput();
    },
    ended() {
      mode = "idle";
    },
  };
}
