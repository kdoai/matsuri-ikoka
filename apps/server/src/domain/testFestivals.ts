// domain とツールのテストで使う、架空の祭りを作る道具。実在の祭りではない。
import {
  type Festival,
  type FestivalInput,
  FestivalSchema,
  type Occurrence,
} from "@matsuri-ikoka/schema";
import { fictionalFestival, fictionalSource } from "@matsuri-ikoka/schema/testing";

export interface TestFestivalOptions {
  id: string;
  date?: string;
  endDate?: string;
  status?: Occurrence["status"];
  /** 開催回の出典の確度。official か corroborated なら、発表済みのとき「確認済み」になる */
  confidence?: "official" | "corroborated" | "single" | "inferred";
  start?: string | null;
  end?: string | null;
  popularity?: Festival["popularity"];
  scaleTier?: Festival["scaleTier"];
  category?: Festival["category"];
  /** みなと中央駅からの所要時間。null なら主要駅からの所要時間を持たない */
  fromHubMinutes?: [number, number] | null;
  optOut?: boolean;
  edit?: (festival: FestivalInput) => void;
}

/** 架空の祭り「鈴鳴灯籠まつり」をもとに、日付や規模を変えた祭りを作る */
export function testFestival(options: TestFestivalOptions): Festival {
  const festival = fictionalFestival();
  festival.id = options.id;
  festival.name = { ja: `${options.id} まつり` };
  festival.popularity = options.popularity ?? "local";
  festival.scaleTier = options.scaleTier ?? "S";
  festival.category = options.category ?? "lantern";
  festival.optOut = options.optOut ?? false;
  festival.occurrences = [
    {
      date: options.date ?? "2026-08-16",
      ...(options.endDate === undefined ? {} : { endDate: options.endDate }),
      start: options.start === undefined ? "18:30" : options.start,
      end: options.end === undefined ? "21:00" : options.end,
      status: options.status ?? "announced",
      rainPolicy: "小雨決行",
      sources: [fictionalSource(`${options.id}/2026`, options.confidence ?? "official")],
    },
  ];
  const minutes = options.fromHubMinutes === undefined ? [40, 50] : options.fromHubMinutes;
  festival.access.fromHubs =
    minutes === null ? [] : [{ hub: "みなと中央駅", minutes: minutes as [number, number] }];
  options.edit?.(festival);
  return FestivalSchema.parse(festival);
}

/** id で祭りを引く関数にする */
export function lookup(...festivals: Festival[]): (id: string) => Festival | undefined {
  const byId = new Map(festivals.map((f) => [f.id, f]));
  return (id) => byId.get(id);
}
