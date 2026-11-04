import type { PartialTripConditions, TransportMode } from "@matsuri-ikoka/schema";

// 聞き取りで分かった「想定している交通手段」が、道のりの組み方に与える効果。
// 祭りのデータにあるのは最寄り駅・主要駅からの目安・駐車場・交通規制だけで、
// 便や時刻はないので、データにないことを書かないよう決まりを渡す。

export const TRANSPORT_LABELS: Record<TransportMode, string> = {
  car: "車",
  shinkansen: "新幹線",
  local_train: "在来線",
  bus: "バス",
  ferry: "船",
  plane: "飛行機",
  rental_car: "レンタカー",
  walk: "徒歩",
};

/** 便と時刻が祭りのデータにない交通手段 */
const SCHEDULED_ELSEWHERE: readonly TransportMode[] = ["bus", "ferry", "plane"];

export interface TransportEffects {
  /** 車で会場へ行くかもしれない（駐車場と交通規制を先に確かめる） */
  usesCar: boolean;
  /** 旅程係と周辺係に伝える、道のりの決まり */
  rules: string[];
}

/** 想定している交通手段から、道のりの組み方の決まりを作る。空なら「おまかせ」で決まりは足さない */
export function transportEffects(
  conditions: Pick<PartialTripConditions, "transport">,
): TransportEffects {
  const modes = conditions.transport ?? [];
  const rules: string[] = [];
  const usesCar = modes.includes("car") || modes.includes("rental_car");

  if (modes.length > 0) {
    rules.push(
      `想定している交通手段（${modes.map((m) => TRANSPORT_LABELS[m]).join("・")}）で道のりを組み、ほかの手段は使わない。` +
        "所要時間はツールの目安だけを使い、選んだ手段では行けないときはそう伝える",
    );
  }
  if (usesCar) {
    rules.push(
      "駐車場と交通規制を先に確かめる。駐車場のない祭りでは、近くの駅から歩くか、公共の交通をすすめる",
    );
  }
  const scheduled = modes.filter((m) => SCHEDULED_ELSEWHERE.includes(m));
  if (scheduled.length > 0) {
    rules.push(
      `${scheduled.map((m) => TRANSPORT_LABELS[m]).join("・")}の便と時刻はデータにないので、便名や時刻は書かず、行く前に運行する会社で確かめるよう伝える`,
    );
  }

  return { usesCar, rules };
}
