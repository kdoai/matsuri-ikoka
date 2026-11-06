// 週次の調査で、コードとセッションが共有する名前と、調査員に渡す情報。
// エージェントの定義そのものは managed-agents/ のファイルにある。
import type { Festival, IsoDate } from "../packages/schema/src";
import { currentOccurrence, type RefreshTarget } from "./research-schedule";

/** managed-agents/ のファイルの name と同じにする（テストで確かめる） */
export const RESEARCH_NAMES = {
  queueStore: "matsuri-research-queue",
  deployment: "matsuri-weekly-research",
} as const;

/** 調査員に渡す、1つの祭りの情報。名前と場所と今の開催回と、分かっている出典だけにする */
export function researchBrief(festival: Festival, target: RefreshTarget, today: IsoDate) {
  const { occurrence } = currentOccurrence(festival, today);
  const sources = [...(occurrence?.sources ?? []), ...festival.sources];
  return {
    id: festival.id,
    name: festival.name,
    municipalities: festival.municipalities,
    venue: festival.venue.name,
    occurrenceDate: target.nextDate,
    estimatedDate: occurrence === null,
    currentOccurrence:
      occurrence === null
        ? null
        : {
            date: occurrence.date,
            endDate: occurrence.endDate ?? null,
            status: occurrence.status,
          },
    pastDates: festival.occurrences.map((o) => o.date).filter((date) => date < today),
    knownSources: [...new Map(sources.map((s) => [s.url, s.confidence])).entries()].map(
      ([url, confidence]) => ({ url, confidence }),
    ),
    reasons: target.reasons,
    notes: target.notes,
  };
}
