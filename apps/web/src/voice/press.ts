// 声で話すボタンの押し方。画面の部品から切り離して、テストで確かめられるようにする。
// - マウスとキー：押している間だけ聞き、離したら止める
// - 指やペン：長く押したときは押している間だけ聞く。短く押したとき（スクリーンリーダーのダブルタップのように、
//   押してすぐ離れるとき）は聞き続け、次に押すか、ボタンの外を押したら止める
// - click だけが届くとき（スクリーンリーダーの決定など）：押すたびに聞く・止めるを切り替える

/** 指やペンでこれより短く押して離したときは、離しても止めず、次に押すまで聞き続ける */
export const TAP_MS = 300;

/** 押したもの。touch は指とペン */
export type PressSource = "mouse" | "touch" | "key";

/** 聞いているあいだの止め方。hold は離したら止める、toggle は次に押したら止める */
export type PressMode = "idle" | "hold" | "toggle";

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
  /** 聞き始めたとき（読み上げを止める） */
  started(): void;
  /** 止め方が変わったとき（聞いている表示の文を出し分ける） */
  modeChanged(mode: PressMode): void;
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
  /** ボタンの外が押されたとき */
  outside(): void;
  /** 聞き取った文を下書きに入れたとき */
  filled(): void;
  /** 聞き取りが終わったとき（文が入った・失敗した・やめた） */
  ended(): void;
}

export function createPressControl(deps: PressDeps): PressControl {
  /** いま押されているもの */
  let held: PressSource | null = null;
  let downAt = 0;
  let mode: PressMode = "idle";
  /** 押下に続いて届く click を、別の押し直しと取り違えない */
  let fromPress = false;
  /** キーやボタンを押している間に文が入ったら、離してから入力欄へ移る */
  let focusPending = false;

  const setMode = (next: PressMode) => {
    if (mode === next) return;
    mode = next;
    deps.modeChanged(next);
  };
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
    deps.started();
    setMode(next);
    return true;
  };
  const finish = () => {
    deps.stop();
    setMode("idle");
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
        // 指で短く押したときだけ聞き続ける（マウスのクリックやキーは、離したら止める）
        if (source === "touch" && deps.now() - downAt < TAP_MS) setMode("toggle");
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
      setMode("idle");
      held = null;
      focusPending = false;
      release();
    },
    outside() {
      if (mode === "toggle" && deps.listening()) finish();
    },
    filled() {
      if (held !== null) focusPending = true;
      else deps.focusInput();
    },
    ended() {
      setMode("idle");
    },
  };
}
