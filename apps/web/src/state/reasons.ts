import type {
  Festival,
  FestivalCandidate,
  PartialTripConditions,
  Preferences,
} from "@matsuri-ikoka/schema";

// 候補カードの「合う理由」。候補・祭りのデータ・条件・こだわりの項目だけから、コードで決める。

export type FitReason =
  | { kind: "onWishDay" }
  | { kind: "fromOrigin"; hub: string; min: number; max: number }
  | { kind: "local" }
  | { kind: "regional" }
  | { kind: "canJoin" };

const MAX_REASONS = 3;

export function fitReasons(
  candidate: FestivalCandidate,
  festival: Festival | null,
  conditions: PartialTripConditions,
  preferences: Preferences,
): FitReason[] {
  const reasons: FitReason[] = [];
  if (candidate.daysFromWish === 0) {
    reasons.push({ kind: "onWishDay" });
  }
  if (festival !== null) {
    const fromOrigin = festival.access.fromHubs.find((hub) => hub.hub === conditions.origin);
    if (fromOrigin !== undefined) {
      reasons.push({
        kind: "fromOrigin",
        hub: fromOrigin.hub,
        min: fromOrigin.minutes[0],
        max: fromOrigin.minutes[1],
      });
    }
    // 穴場を好む人（おまかせを含む）にだけ、知名度の低さを理由として出す
    if (preferences.spot !== "classic") {
      if (festival.popularity === "local") {
        reasons.push({ kind: "local" });
      } else if (festival.popularity === "regional") {
        reasons.push({ kind: "regional" });
      }
    }
    const participation = festival.etiquette.participation;
    if (participation === "join_open" || participation === "join_by_application") {
      reasons.push({ kind: "canJoin" });
    }
  }
  return reasons.slice(0, MAX_REASONS);
}
