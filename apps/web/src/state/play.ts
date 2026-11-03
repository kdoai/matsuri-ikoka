import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Chick, Interaction } from "../scenes/controls";

// 店の中で遊ぶ状態（近くで使えるもの・座っているか・見つけたひよこ・仕掛けの結果）。
// 3D の旅人が書き込み、HUD（文字の案内と読み上げ）が読む。相談の状態とは分けて持つ。
// HUD から 3D への頼みごと（「使う」を押した）は、通し番号で渡す。

/** 仕掛けを使ったときの知らせ。文言は画面の辞書で作る */
export type PlayNotice =
  | { kind: "omikuji"; fortune: number }
  | { kind: "gacha"; prize: number }
  | { kind: "gimmick"; interaction: Interaction }
  | { kind: "chick"; found: number }
  | { kind: "allChicks" };

export interface PlayState {
  /** 3D の旅人がいるか（いなければ「話す」は入力欄へ） */
  active: boolean;
  /** 一度でも旅人を動かしたか（操作の案内をたたむのに使う） */
  moved: boolean;
  near: Interaction | null;
  sitting: boolean;
  chicks: Chick[];
  notice: { seq: number; value: PlayNotice } | null;
  /** 「使う」の頼みの通し番号 */
  interactSeq: number;
}

export interface PlayActions {
  setActive(active: boolean): void;
  markMoved(): void;
  setNear(near: Interaction | null): void;
  setSitting(sitting: boolean): void;
  /** ひよこを見つけた。初めて見つけたときだけ true */
  findChick(chick: Chick): boolean;
  notify(value: PlayNotice): void;
  requestInteract(): void;
}

export type PlayStore = PlayState & PlayActions;

function sameInteraction(a: Interaction | null, b: Interaction | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createPlayStore() {
  return createStore<PlayStore>()((set, get) => ({
    active: false,
    moved: false,
    near: null,
    sitting: false,
    chicks: [],
    notice: null,
    interactSeq: 0,
    setActive(active) {
      set({ active, ...(active ? {} : { near: null, sitting: false }) });
    },
    markMoved() {
      if (!get().moved) set({ moved: true });
    },
    setNear(near) {
      if (!sameInteraction(get().near, near)) set({ near });
    },
    setSitting(sitting) {
      if (get().sitting !== sitting) set({ sitting });
    },
    findChick(chick) {
      const { chicks } = get();
      if (chicks.includes(chick)) return false;
      set({ chicks: [...chicks, chick].sort((a, b) => a - b) });
      return true;
    },
    notify(value) {
      set((state) => ({ notice: { seq: (state.notice?.seq ?? 0) + 1, value } }));
    },
    requestInteract() {
      set((state) => ({ interactSeq: state.interactSeq + 1 }));
    },
  }));
}

/** 画面に1つだけの遊びの状態 */
export const playStore = createPlayStore();

export function usePlay<T>(selector: (state: PlayStore) => T): T {
  return useStore(playStore, selector);
}
