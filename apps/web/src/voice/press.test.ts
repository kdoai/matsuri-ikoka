import { describe, expect, it } from "vitest";
import { createPressControl, type PressDeps, TAP_MS } from "./press";

function setup(options: { accepted?: boolean; startOk?: boolean } = {}) {
  let time = 0;
  let accepted = options.accepted ?? true;
  let listening = false;
  const log: string[] = [];
  const modes: string[] = [];
  const deferred: (() => void)[] = [];
  const deps: PressDeps = {
    now: () => time,
    accepted: () => accepted,
    showNotice: () => log.push("notice"),
    start: () => {
      if (options.startOk === false) return false;
      listening = true;
      log.push("start");
      return true;
    },
    stop: () => {
      listening = false;
      log.push("stop");
    },
    listening: () => listening,
    started: () => log.push("started"),
    modeChanged: (mode) => modes.push(mode),
    focusInput: () => log.push("focus"),
    defer: (callback) => deferred.push(callback),
  };
  const control = createPressControl(deps);
  return {
    control,
    log,
    modes,
    wait: (ms: number) => {
      time += ms;
    },
    /** 押下に続く click を見分ける待ちを終える */
    settle: () => {
      for (const callback of deferred.splice(0)) callback();
    },
    accept: () => {
      accepted = true;
    },
    /** 聞き取りが終わった（認識が止まった） */
    end: () => {
      listening = false;
      control.ended();
    },
  };
}

describe("createPressControl", () => {
  it("長く押したときは、押している間だけ聞く", () => {
    const { control, log, wait } = setup();
    control.down("touch");
    wait(TAP_MS + 200);
    control.up("touch");
    expect(log).toEqual(["start", "started", "stop"]);
  });

  it("マウスで短くクリックしたときは、離したら止める", () => {
    const { control, log, wait } = setup();
    control.down("mouse");
    wait(100);
    control.up("mouse");
    control.click();
    expect(log).toEqual(["start", "started", "stop"]);
  });

  it("キーを短く押したときも、離したら止める", () => {
    const { control, log, wait } = setup();
    control.down("key");
    wait(50);
    control.up("key");
    expect(log).toEqual(["start", "started", "stop"]);
  });

  it("指で押してすぐ離したとき（ダブルタップなど）は聞き続け、次に押したら止める", () => {
    const { control, log, modes, wait, settle } = setup();
    control.down("touch");
    wait(40);
    control.up("touch");
    control.click();
    settle();
    expect(log).toEqual(["start", "started"]);
    expect(modes).toEqual(["hold", "toggle"]);
    control.down("touch");
    wait(40);
    control.up("touch");
    control.click();
    expect(log).toEqual(["start", "started", "stop"]);
  });

  it("click だけが届くときは、押すたびに聞く・止めるを切り替える", () => {
    const { control, log, modes } = setup();
    control.click();
    expect(log).toEqual(["start", "started"]);
    expect(modes).toEqual(["toggle"]);
    control.click();
    expect(log).toEqual(["start", "started", "stop"]);
  });

  it("押したあとに続いて届く click では、止めない", () => {
    const { control, log, wait } = setup();
    control.down("touch");
    wait(TAP_MS + 10);
    control.click();
    expect(log).toEqual(["start", "started"]);
    control.up("touch");
    expect(log.at(-1)).toBe("stop");
  });

  it("はじめてキーで押して説明が出たあとも、次に押せば聞ける（離したことが届かなくても残らない）", () => {
    const { control, log, accept, settle, wait } = setup({ accepted: false });
    control.down("key");
    // 説明の見出しへ焦点が移り、離したことはボタンに届かない
    control.blur();
    settle();
    expect(log).toEqual(["notice"]);
    accept();
    control.click();
    expect(log).toEqual(["notice", "start", "started"]);
    control.click();
    control.down("key");
    wait(TAP_MS + 10);
    control.up("key");
    expect(log).toEqual(["notice", "start", "started", "stop", "start", "started", "stop"]);
  });

  it("説明が出たあとは、焦点が外れたことが届かなくても、続く click で止まらない", () => {
    const { control, log, accept, settle } = setup({ accepted: false });
    control.down("key");
    settle();
    accept();
    control.click();
    expect(log).toEqual(["notice", "start", "started"]);
  });

  it("キーを押している間に文が入ったら、離してから入力欄へ移る", () => {
    const { control, log, wait, end } = setup();
    control.down("key");
    wait(TAP_MS + 10);
    end();
    control.filled();
    expect(log).not.toContain("focus");
    control.up("key");
    expect(log.at(-1)).toBe("focus");
  });

  it("押していないときに文が入ったら、すぐ入力欄へ移る", () => {
    const { control, log, end } = setup();
    control.click();
    end();
    control.filled();
    expect(log.at(-1)).toBe("focus");
  });

  it("焦点が外れたら、聞くのをやめ、入力欄へ移る約束も消す", () => {
    const { control, log, wait } = setup();
    control.down("key");
    wait(TAP_MS + 10);
    control.filled();
    control.blur();
    control.up("key");
    expect(log).toEqual(["start", "started", "stop"]);
  });

  it("聞き始められなかったときは、聞いている扱いにしない", () => {
    const { control, log, wait } = setup({ startOk: false });
    control.down("touch");
    wait(10);
    control.up("touch");
    control.click();
    expect(log).toEqual([]);
  });

  it("切り替えで聞いている間にボタンの外を押したら止める。押している間だけ聞くときは止めない", () => {
    const { control, log, wait } = setup();
    control.click();
    control.outside();
    expect(log).toEqual(["start", "started", "stop"]);
    control.down("mouse");
    wait(TAP_MS + 10);
    control.outside();
    expect(log.at(-1)).toBe("started");
  });

  it("止めたら、聞いていない表示に戻す", () => {
    const { control, modes, wait } = setup();
    control.down("mouse");
    wait(TAP_MS + 10);
    control.up("mouse");
    expect(modes).toEqual(["hold", "idle"]);
  });
});
