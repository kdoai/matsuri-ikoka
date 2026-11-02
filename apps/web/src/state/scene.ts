import type { ConversationStage, StaffId } from "@matsuri-ikoka/schema";
import { allQuestsDone } from "./selectors";
import type { AppData, QuestId, QuestState, StaffState } from "./types";

// 3D の店内に渡す状態。3D の部品は、これを props で受け取るだけにする（ADR 0003）。
// 同じ情報は 2D の StaffPanel とクエストの掲示板でも、文字で読める。

export interface ShopSceneProps {
  /** スタッフごとの状態（待機・移動・作業・戻る、動き、吹き出し） */
  staff: Readonly<Record<StaffId, StaffState>>;
  stage: ConversationStage;
  quests: Readonly<Record<QuestId, QuestState>>;
  /** 3つのクエストがそろったか（掲示板の見た目に使う） */
  questsComplete: boolean;
  /** 「旅のしおり完成」の演出の最中か（カメラを寄せる合図） */
  celebrating: boolean;
  /** 動きを減らす設定。true のときは画面が 2D を主にするので、3D は出さない */
  reducedMotion: boolean;
}

export function selectSceneProps(state: AppData, reducedMotion: boolean): ShopSceneProps {
  return {
    staff: state.staff,
    stage: state.session.stage,
    quests: state.quests,
    questsComplete: allQuestsDone(state),
    celebrating: state.ui.celebrating,
    reducedMotion,
  };
}
