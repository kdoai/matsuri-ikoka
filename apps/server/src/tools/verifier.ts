import type { Festival, IsoDate } from "@matsuri-ikoka/schema";
import type { VerificationReport } from "../domain/verification";

/**
 * 確定前に、祭りの開催予定を公式の情報で確かめる口。
 * live では Web 検索だけを使うエージェントが受け持つ（agent/webVerifier.ts）。
 * 返す報告は信用しない入力として、domain/verification.ts のルールで結果を決め直す。
 */
export interface FestivalVerifier {
  verify(input: {
    festival: Festival;
    date: IsoDate;
    signal: AbortSignal;
  }): Promise<VerificationReport>;
}

/** 確かめる手段がないとき（mock やテスト）。いつも「確認できず」を返す */
export const unavailableVerifier: FestivalVerifier = {
  async verify() {
    return { result: "not_found", sources: [], note: "再確認の手段がありません" };
  },
};
