import type {
  CheckedChange,
  Confidence,
  IsoDate,
  LocalTime,
  PatrolPage,
  TripWatch,
} from "@matsuri-ikoka/schema";

// 見回りのコードの中で使う型。Zod のスキーマにしないのは、どれも外から受け取らず、外へも渡さないため。

/** 頼まれた旅。ref は旅の置き場を指す値で、利用者の ID を含む。見回り係にも見回りの控えにも渡さない */
export interface WatchedTrip {
  ref: string;
  watch: TripWatch;
}

/** 比べる元の開催の日時。日付は必ず分かっている（祭りのデータか、検問を通った前回の値） */
export interface ScheduleBaseline {
  date: IsoDate;
  start: LocalTime | null;
  end: LocalTime | null;
}

/** ページの比較の控え。行のハッシュだけを持ち、ページの文章を持たない */
export interface PatrolPageRecord {
  url: string;
  /** 前回の行のハッシュ。コードで読めたことがなければ null */
  lineHashes: string[] | null;
  /** 見回り係の結果を待っている、今回の行のハッシュ。実際に開いたと確かめてから lineHashes にする */
  pendingHashes: string[] | null;
  /** 続けて失敗した回数 */
  failures: number;
  /** 次に読んでよい時刻 */
  nextTryAt: number;
}

export interface PatrolLease {
  holder: string;
  expiresAt: number;
}

/** patrols/{祭りの ID と開催日} の中身。利用者の情報を持たない */
export interface PatrolRecord {
  key: string;
  festivalId: string;
  date: IsoDate;
  /** 検問を通った、いまの開催の日時。まだなければ祭りのデータと比べる */
  observed: ScheduleBaseline | null;
  /** 検問を通って中止と決まっている */
  cancelled: boolean;
  /** 中止を出したページ。撤回を確かめるときに読む */
  cancelledBy: string[];
  /** 検問を通って、新しい日の分からない延期と決まっている */
  postponed: boolean;
  /** 日程が前の値に戻った回数。同じ内容の変更をもう一度知らせられるように、指紋に入れる */
  changeCount: number;
  /** これまでの日程の値（前の値に戻ったかを見分ける） */
  seenBaselines: string[];
  /** 上限で届けられなかった確かな変化。次の回に届け直す。公開の情報だけで、利用者の情報を持たない */
  undelivered: CheckedChange[];
  pages: PatrolPageRecord[];
  lastCheckedAt: number | null;
  nextCheckAt: number;
  /** この対象が原因と分かっている失敗が続いた回数 */
  failures: number;
  /** ほかの対象といっしょに失敗した回数（セッションの失敗や崩れた報告）。原因が分からないので軽く数える */
  groupFailures: number;
  /** 結果を待っている見回り。待っている間は同じ対象を調べ直さない */
  pending: { patrolId: string; until: number } | null;
  /** 実行権。切れた実行権は、別の実行が引き継ぐ */
  lease: PatrolLease | null;
}

/** 実行の記録に残すページ。ページの文章（変わった行）は残さない */
export interface RunPage {
  url: string;
  reason: PatrolPage["reason"];
  /** 祭りのデータの出典の確度 */
  confidence: Confidence;
}

export interface RunTarget {
  key: string;
  festivalId: string;
  date: IsoDate;
  pages: RunPage[];
}

export type RunStatus = "open" | "done" | "failed";

/** 見回りの1回の実行の記録。何を調べ、何が起きたかを残す。利用者の情報を持たない */
export interface PatrolRun {
  patrolId: string;
  sessionId: string | null;
  status: RunStatus;
  targets: RunTarget[];
  createdAt: number;
  finishedAt: number | null;
  /** 結果を受け取っている実行の実行権（Webhook と定期の確かめが重ならないように） */
  claim: PatrolLease | null;
  /** 失敗の分類 */
  failure: string | null;
  /** 検問の結果の数 */
  counts: Record<string, number>;
  /** 使った費用（セント） */
  costCents: number | null;
  /** 終わったのに、セッションをまだ止めて消していない。セッションにはページの文章が残るので消す */
  needsDisposal: boolean;
}
