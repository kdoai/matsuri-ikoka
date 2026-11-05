import { stepAfterAnswer } from "../../state/consult";
import { useActions, useApp } from "../../state/react";
import { focusStep } from "./Choices";

/** 聞き取りの操作をまとめたもの（段階の部品で使う） */
export function useConsult() {
  const actions = useActions();
  const consult = useApp((state) => state.consult);
  return {
    actions,
    /** 答えたので次へ（確認から直しに来たときは確認へ） */
    advance() {
      actions.setConsultStep(stepAfterAnswer(consult, consult));
      focusStep();
    },
  };
}
