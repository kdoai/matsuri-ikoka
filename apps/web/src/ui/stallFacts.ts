import {
  type Festival,
  type GuideStall,
  type Itinerary,
  itineraryItems,
  mainFestivalDay,
  type Source,
  type Weather,
} from "@matsuri-ikoka/schema";
import { formatDate, formatDateTime, type Messages } from "../i18n";
import type { Locale, VerifyState } from "../state/types";

// 屋台で読める情報を、旅程と祭りのデータだけから組み立てる。その場で文章を作らず、推測で埋めない。
// 3D を使わない画面でも同じものを出す。

export interface StallLink {
  label: string;
  url: string;
}

export interface StallFact {
  label: string;
  lines: string[];
  links: StallLink[];
  sources: Source[];
}

const UNKNOWN = "unknown";

const fact = (
  label: string,
  lines: readonly string[],
  sources: readonly Source[] = [],
  links: readonly StallLink[] = [],
): StallFact => ({ label, lines: [...lines], sources: [...sources], links: [...links] });

/** 同じ URL の出典を1つにする */
function uniqueSources(sources: readonly Source[]): Source[] {
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}

function weatherLine(t: Messages, weather: Weather): string {
  switch (weather.status) {
    case "forecast":
      return t.itinerary.weather.forecast(
        weather.summary,
        weather.precipitationPercent,
        weather.highC,
        weather.lowC,
      );
    case "not_yet":
      return t.itinerary.weather.not_yet;
    case "unavailable":
      return t.itinerary.weather.unavailable;
  }
}

function lodgingFacts(itinerary: Itinerary, t: Messages, locale: Locale): StallFact[] {
  const words = t.street.facts;
  const stays = itinerary.days.flatMap((day) =>
    day.stay === null ? [] : [{ day, stay: day.stay }],
  );
  if (stays.length === 0) return [fact(t.street.stalls.lodging.lead, [words.noStay])];
  return stays.map(({ day, stay }) => {
    const offers = stay.lodging?.offers ?? [];
    return fact(
      formatDate(day.date, locale),
      [
        words.area(stay.area),
        ...(stay.note === undefined ? [] : [stay.note]),
        ...offers.flatMap((offer) =>
          offer.nightlyTotalYen === null
            ? []
            : [t.street.labelled(offer.name, words.nightly(offer.nightlyTotalYen))],
        ),
      ],
      uniqueSources(offers.map((offer) => offer.source)),
      offers.map((offer) => ({ label: words.offerOpen(offer.name), url: offer.bookingUrl })),
    );
  });
}

function accessFacts(
  itinerary: Itinerary,
  festival: Festival | null,
  t: Messages,
  locale: Locale,
): StallFact[] {
  const words = t.street.facts;
  const items = itineraryItems(itinerary);
  const moves = items.flatMap((item) => (item.move === null ? [] : [item]));
  const facts = [
    fact(
      words.route,
      [
        words.routeLine(itinerary.origin, itinerary.returnTo),
        ...moves.map(({ move, name }) =>
          move === null
            ? name
            : t.street.labelled(
                move.from !== undefined && move.to !== undefined
                  ? words.routeLine(move.from, move.to)
                  : name,
                t.itinerary.move(t.itinerary.means[move.means], move.minutes[0], move.minutes[1]),
              ),
        ),
      ],
      uniqueSources(moves.flatMap((item) => item.sources)),
    ),
  ];
  for (const day of itinerary.days) {
    if (day.lastReturn === null || day.lastReturn === undefined) continue;
    facts.push(
      fact(
        t.street.dated(words.lastReturn, formatDate(day.date, locale)),
        [
          words.lastLine(day.lastReturn.station, day.lastReturn.departBy),
          ...(day.lastReturn.note === undefined ? [] : [day.lastReturn.note]),
        ],
        day.lastReturn.sources,
      ),
    );
  }
  if (festival !== null && festival.access.stations.length > 0) {
    facts.push(
      fact(
        words.stations,
        festival.access.stations.map((station) =>
          words.stationLine(station.name, station.walkMinutes[0], station.walkMinutes[1]),
        ),
        festival.access.sources,
      ),
    );
  }
  if (festival !== null && festival.access.trafficRestrictions.length > 0) {
    facts.push(fact(words.traffic, festival.access.trafficRestrictions, festival.access.sources));
  }
  return facts;
}

function etiquetteFacts(
  itinerary: Itinerary,
  festival: Festival | null,
  t: Messages,
  loading: boolean,
): StallFact[] {
  const words = t.etiquette;
  const notes = itinerary.notes.length === 0 ? [] : [fact(t.street.facts.notes, itinerary.notes)];
  if (festival === null) {
    return [
      fact(t.street.stalls.etiquette.lead, [
        loading ? t.street.facts.loading : t.street.facts.none,
      ]),
      ...notes,
    ];
  }
  const { etiquette } = festival;
  const list = (value: string[] | typeof UNKNOWN): string[] =>
    value === UNKNOWN ? [words.unknown] : value;
  const items: StallFact[] = [
    fact(
      words.labels.participation,
      [
        etiquette.participation === UNKNOWN
          ? words.unknown
          : words.participation[etiquette.participation],
      ],
      etiquette.sources,
    ),
    ...(etiquette.howToJoin === null
      ? []
      : [
          fact(words.labels.howToJoin, [
            etiquette.howToJoin === UNKNOWN ? words.unknown : etiquette.howToJoin,
          ]),
        ]),
    fact(words.labels.rules, list(etiquette.rules)),
    fact(words.labels.dress, list(etiquette.dress)),
    fact(words.labels.bring, list(etiquette.bring)),
    fact(words.labels.risk, [
      etiquette.risk === UNKNOWN
        ? words.unknown
        : t.street.labelled(words.risk[etiquette.risk.level], etiquette.risk.reason),
    ]),
    fact(words.labels.photo, [
      etiquette.photo === UNKNOWN
        ? words.unknown
        : etiquette.photo.note === undefined
          ? words.photo[etiquette.photo.policy]
          : t.street.labelled(words.photo[etiquette.photo.policy], etiquette.photo.note),
    ]),
  ];
  return [...items, ...notes];
}

function foodFacts(
  itinerary: Itinerary,
  festival: Festival | null,
  t: Messages,
  locale: Locale,
): StallFact[] {
  const words = t.street.facts;
  const facts: StallFact[] = [];
  for (const day of itinerary.days) {
    if (day.meals === undefined || day.meals.length === 0) continue;
    facts.push(
      fact(
        t.street.dated(words.meals, formatDate(day.date, locale)),
        day.meals.map((meal) => words.mealLine(meal.slot, meal.name)),
        uniqueSources(day.meals.flatMap((meal) => meal.sources)),
      ),
    );
  }
  if (festival !== null) {
    facts.push(
      fact(words.foodStallsLabel, [
        festival.food.stalls === UNKNOWN
          ? t.etiquette.unknown
          : words.foodStalls[festival.food.stalls],
      ]),
    );
    if (festival.food.local.length > 0) {
      facts.push(
        fact(
          words.localFood,
          festival.food.local.map((food) =>
            food.note === undefined ? food.name : t.street.labelled(food.name, food.note),
          ),
          uniqueSources(festival.food.local.flatMap((food) => food.sources)),
        ),
      );
    }
  }
  return facts.length > 0 ? facts : [fact(t.street.stalls.food.lead, [words.none])];
}

function weatherFacts(itinerary: Itinerary, t: Messages, locale: Locale): StallFact[] {
  const facts = itinerary.days.map((day) =>
    fact(
      formatDate(day.date, locale),
      [weatherLine(t, day.weather)],
      day.weather.status === "forecast" ? [day.weather.source] : [],
    ),
  );
  const rainy = itinerary.alternatives.map((alternative) => alternative.summary);
  return rainy.length > 0 ? [...facts, fact(t.street.facts.alternatives, rainy)] : facts;
}

function headquartersFacts(
  itinerary: Itinerary,
  festival: Festival | null,
  verify: VerifyState | undefined,
  t: Messages,
  locale: Locale,
): StallFact[] {
  const words = t.street.facts;
  const day = mainFestivalDay(itinerary);
  const item = day.items.find(
    (entry) => entry.type === "festival" && entry.festivalId === itinerary.mainFestivalId,
  );
  const name =
    festival === null ? (item?.name ?? null) : (festival.name[locale] ?? festival.name.ja);
  const facts: StallFact[] = [];
  if (name !== null) {
    facts.push(
      fact(
        words.festival,
        [name, ...(festival === null ? [] : [words.venue(festival.venue.name)])],
        festival?.sources ?? [],
      ),
    );
  }
  if (item !== undefined) {
    facts.push(
      fact(
        words.schedule,
        [words.scheduleLine(formatDate(day.date, locale), item.start, item.end)],
        item.sources,
      ),
    );
  }
  // 再確認の結果はストアが新しい。残した旅を開いたときは、旅程に書いてあるものを使う
  const { verification } = itinerary;
  const check = t.itinerary.verification;
  if (verify?.result !== null && verify?.result !== undefined && verify.checkedAt !== null) {
    facts.push(
      fact(
        words.check,
        [
          check[verify.result],
          check.checkedAt(formatDateTime(verify.checkedAt, locale)),
          ...(verify.note === null ? [] : [verify.note]),
        ],
        verify.sources,
      ),
    );
  } else if (verification.status === "pending") {
    facts.push(fact(words.check, [check.pending]));
  } else {
    facts.push(
      fact(
        words.check,
        [
          check[verification.status],
          check.checkedAt(formatDateTime(verification.checkedAt, locale)),
          ...(verification.note === undefined ? [] : [verification.note]),
        ],
        verification.sources,
      ),
    );
  }
  return facts;
}

export interface StallData {
  itinerary: Itinerary | null;
  festival: Festival | null;
  /** 祭りのデータをまだ読んでいる途中か */
  festivalLoading: boolean;
  /** 確定前の再確認の結果 */
  verify?: VerifyState;
}

/** 屋台で読める情報。旅程がなければ「まだ分かっていません」だけを返す */
export function stallFacts(
  stall: GuideStall,
  { itinerary, festival, festivalLoading, verify }: StallData,
  t: Messages,
  locale: Locale,
): StallFact[] {
  if (itinerary === null) return [fact(t.street.stalls[stall].lead, [t.street.facts.none])];
  switch (stall) {
    case "lodging":
      return lodgingFacts(itinerary, t, locale);
    case "access":
      return accessFacts(itinerary, festival, t, locale);
    case "etiquette":
      return etiquetteFacts(itinerary, festival, t, festivalLoading);
    case "food":
      return foodFacts(itinerary, festival, t, locale);
    case "weather":
      return weatherFacts(itinerary, t, locale);
    case "headquarters":
      return headquartersFacts(itinerary, festival, verify, t, locale);
  }
}
