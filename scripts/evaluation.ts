// 祭りのデータから、評価の数字（情報の壁・作法の壁）を集計する。
// ファイルの読み込みはしない（呼ぶ側が渡す）ので、テストではファイルなしで使える。
import {
  CONFIDENCE_LEVELS,
  type Confidence,
  ETIQUETTE_ITEMS,
  type EtiquetteItem,
  type Festival,
  type IsoDate,
  isOccurrenceConfirmed,
  type Occurrence,
  strongestConfidence,
  UNKNOWN,
} from "../packages/schema/src";

export interface Ratio {
  count: number;
  total: number;
}

export interface DataEvaluation {
  /** 集計の基準の日 */
  today: IsoDate;
  /** 集計した祭り（掲載停止を除く） */
  festivals: number;
  /** 知名度が local（大手の観光サイトにほとんど載っていない）の祭り */
  local: Ratio;
  /** 次の開催回が、発表済みで、公式か複数の情報源で確かめられている祭り */
  confirmed: Ratio;
  /** 次の開催回の出典のうち、いちばん強い確度ごとの祭りの数 */
  occurrenceConfidence: Record<Confidence, number>;
  /** 作法の項目のうち、値が分かっているもの（当てはまらない項目は除く） */
  etiquetteKnown: Ratio;
  /** 作法の項目ごとの、値が分かっている祭り */
  etiquetteKnownByItem: Record<EtiquetteItem, Ratio>;
  /** gaps（調べても分からなかったこと）の数の平均 */
  gapsPerFestival: number;
}

/**
 * 評価に使う開催回。基準の日に終わっていない開催回のうちいちばん早いもの、
 * なければいちばん新しい過去の開催回
 */
export function nextOccurrence(festival: Festival, today: IsoDate): Occurrence {
  const sorted = [...festival.occurrences].sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = sorted.find((o) => (o.endDate ?? o.date) >= today);
  // occurrences はスキーマで1件以上ある
  return upcoming ?? (sorted.at(-1) as Occurrence);
}

export function evaluateFestivals(
  festivals: readonly Festival[],
  { today }: { today: IsoDate },
): DataEvaluation {
  const listed = festivals.filter((f) => !f.optOut);
  const total = listed.length;

  const occurrenceConfidence = Object.fromEntries(
    CONFIDENCE_LEVELS.map((level) => [level, 0]),
  ) as Record<Confidence, number>;
  let confirmed = 0;
  for (const festival of listed) {
    const occurrence = nextOccurrence(festival, today);
    if (isOccurrenceConfirmed(occurrence)) confirmed += 1;
    const confidence = strongestConfidence(occurrence.sources);
    if (confidence !== null) occurrenceConfidence[confidence] += 1;
  }

  const etiquetteKnownByItem = Object.fromEntries(
    ETIQUETTE_ITEMS.map((item) => {
      // howToJoin が null の祭り（見学だけ）は、当てはまらないので分母に入れない
      const applicable = listed.filter((f) => f.etiquette[item] !== null);
      const known = applicable.filter((f) => f.etiquette[item] !== UNKNOWN);
      return [item, { count: known.length, total: applicable.length }];
    }),
  ) as Record<EtiquetteItem, Ratio>;
  const etiquetteKnown = Object.values(etiquetteKnownByItem).reduce<Ratio>(
    (sum, r) => ({ count: sum.count + r.count, total: sum.total + r.total }),
    { count: 0, total: 0 },
  );

  const gaps = listed.reduce((sum, f) => sum + f.gaps.length, 0);

  return {
    today,
    festivals: total,
    local: { count: listed.filter((f) => f.popularity === "local").length, total },
    confirmed: { count: confirmed, total },
    occurrenceConfidence,
    etiquetteKnown,
    etiquetteKnownByItem,
    gapsPerFestival: total === 0 ? 0 : gaps / total,
  };
}

/** 割合を「12 / 20（60%）」の形にする。分母が0なら割合を出さない */
export function formatRatio({ count, total }: Ratio): string {
  if (total === 0) return `${count} / ${total}（—）`;
  return `${count} / ${total}（${Math.round((count / total) * 100)}%）`;
}
