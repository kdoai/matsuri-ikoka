import type { ConversationStage, StaffId } from "@matsuri-ikoka/schema";
import type { AppData, StaffState } from "./types";

// 3D の店内に渡す状態。3D の部品は、これを props で受け取るだけにする（ADR 0003）。
// 同じ情報は 2D のスタッフの一覧と会話の窓でも、文字で読める。

/** 画面の上で、会話の窓やパネルが重なる幅（CSS の px）。3D はこの内側に店を収めて映す */
export interface FrameInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: FrameInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

export interface ShopSceneProps {
  /** スタッフごとの状態（待機・移動・作業・戻る、動き、吹き出し） */
  staff: Readonly<Record<StaffId, StaffState>>;
  stage: ConversationStage;
  /** 「旅のしおり完成」の演出の最中か（カメラを寄せる合図） */
  celebrating: boolean;
  /** 動きを減らす設定。true のときは画面が 2D を主にするので、3D は出さない */
  reducedMotion: boolean;
  /** 画面の部品が重なる場所（画面の並びの情報。ストアの状態ではない） */
  frame: FrameInsets;
  /** 返答を待っているか（旅人の表情に使う） */
  talking: boolean;
  /** 旅人がコンシェルジュに話しかけたとき（会話の窓の入力欄へ）。ほかのスタッフとは 3D の中でおしゃべりするだけ */
  onTalk?: (staff: StaffId) => void;
  /** 会話の窓を出しているか（出していない間は、コンシェルジュが「話しかけてね」と案内する） */
  dialogueOpen: boolean;
  /** のれんをくぐって店の外へ出たとき */
  onExit?: () => void;
  /** 店内を描けたとき（それまでは画面が読み込みの表示を出す） */
  onReady?: () => void;
  /** ゲームパッドの X・Y・＋（スタート）を押したとき */
  onPad?: (command: "details" | "map" | "menu") => void;
}

export function selectSceneProps(
  state: AppData,
  reducedMotion: boolean,
  frame: FrameInsets = NO_INSETS,
): ShopSceneProps {
  return {
    frame,
    talking: state.session.streaming,
    dialogueOpen: state.ui.dialogueOpen,
    staff: state.staff,
    stage: state.session.stage,
    celebrating: state.ui.celebrating,
    reducedMotion,
  };
}
