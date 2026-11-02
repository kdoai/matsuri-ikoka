import {
  DateWishSchema,
  type Festival,
  type FestivalCandidate,
  type IsoDate,
  IsoDateSchema,
  ItineraryItemSchema,
  ItinerarySchema,
  LocalTimeSchema,
  MOVE_MODES,
  PartySchema,
  PreferencesSchema,
  SlugSchema,
  type SpotPin,
  STAY_TYPES,
  type ToolName,
  type Weather,
} from "@matsuri-ikoka/schema";
import { z } from "zod";
import { arrivalBufferMinutes } from "../domain/arrivalBuffer";
import { daysBetween, laterDate } from "../domain/calendar";
import {
  matchHub,
  searchFestivalDates,
  searchRanges,
  toCandidate,
  travelMinutesFrom,
} from "../domain/dateWindow";
import { buildItinerary, type ItineraryDraft } from "../domain/itinerary";
import { selectNearbySpots } from "../domain/nearby";
import { occurrenceOn } from "../domain/planCheck";
import { preferenceEffects } from "../domain/preferences";
import { decideVerification } from "../domain/verification";
import { randomId } from "../session/sessionStore";
import { TOOL_TIMEOUT_MS, type ToolContext } from "./context";

// 接客エージェントに渡す6つのツール。入出力は Zod で決め、計算と絞り込みは domain の関数で行う。
// 祭りの日時・場所・営業時間・出典は、祭りのデータとツールの結果だけから返す。

/** ツールの失敗。message はエージェントに返す（利用者にそのまま見せる文ではない） */
export class ToolError extends Error {}

export interface MatsuriTool {
  name: ToolName;
  description: string;
  input: z.ZodRawShape;
  timeoutMs: number;
  run(args: unknown, ctx: ToolContext, signal: AbortSignal): Promise<Record<string, unknown>>;
}

function defineTool<Shape extends z.ZodRawShape, Output extends Record<string, unknown>>(def: {
  name: ToolName;
  description: string;
  input: Shape;
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext, signal: AbortSignal): Promise<Output>;
}): MatsuriTool {
  return {
    ...def,
    timeoutMs: TOOL_TIMEOUT_MS[def.name],
    run: async (args, ctx, signal) =>
      def.run(z.object(def.input).parse(args) as z.infer<z.ZodObject<Shape>>, ctx, signal),
  };
}

function festivalOf(ctx: ToolContext, id: string): Festival {
  const festival = ctx.festivals.get(id);
  if (festival === undefined) throw new ToolError(`祭り「${id}」は祭りのデータにありません`);
  return festival;
}

/** 日付の指定がないとき、その祭りへ行く日を、候補・旅程・開催回から決める */
function visitDate(ctx: ToolContext, festival: Festival, given?: IsoDate): IsoDate {
  if (given !== undefined) return given;
  const itinerary = ctx.session.itineraryId
    ? ctx.itineraries.get(ctx.session.itineraryId)
    : undefined;
  if (itinerary?.mainFestivalId === festival.id) return itinerary.date;
  const candidate = ctx.session.candidates.find((c) => c.festivalId === festival.id);
  if (candidate !== undefined) return candidate.date;
  const today = ctx.today();
  const upcoming = festival.occurrences
    .filter((o) => (o.endDate ?? o.date) >= today && o.status !== "cancelled")
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (upcoming === undefined)
    throw new ToolError("この祭りの、これからの開催日がデータにありません");
  return laterDate(upcoming.date, today);
}

const weatherKey = (festivalId: string, date: IsoDate) => `${festivalId}@${date}`;

const ItineraryItemDraftSchema = z
  .strictObject({ ...ItineraryItemSchema.shape })
  .omit({ changedInVersion: true });

/** 旅程係が書く下書き。ID・版・再確認・天気はサーバーが付ける */
export const ItineraryDraftSchema = z
  .strictObject({ ...ItinerarySchema.shape, items: z.array(ItineraryItemDraftSchema).min(1) })
  .omit({ id: true, version: true, verification: true, weather: true });

// ---------------------------------------------------------------------------

export const searchFestivals = defineTool({
  name: "search_festivals",
  description:
    "希望日（または期間）・出発地・日帰りか宿泊かに合う祭りを、祭りのデータから最大3件探す。" +
    "希望日の祭りを先に並べ、足りなければ前後2週間で補い、希望日からのずれ（日）を付ける。" +
    "今日より前の日・中止・掲載停止の祭りは出ない。日帰りは移動の上限を超える祭りを除く。",
  input: {
    when: DateWishSchema.describe(
      "希望日。1日なら {kind:'date',date}、期間なら {kind:'range',from,to}",
    ),
    origin: z.string().trim().min(1).max(50).describe("出発地（駅名まで）"),
    stay: z.enum(STAY_TYPES).describe("day_trip 日帰り / overnight 宿泊"),
    party: PartySchema.optional().describe("大人と子どもの人数（分かれば）"),
    preferences: PreferencesSchema.optional().describe(
      "会話で読み取れたこだわり。省略すると画面で選んでいるこだわりを使う",
    ),
    maxTravelMinutes: z
      .number()
      .int()
      .min(30)
      .max(600)
      .optional()
      .describe("日帰りの片道の上限（分）。利用者が言ったときだけ"),
  },
  async run(args, ctx) {
    const { session } = ctx;
    if (args.preferences !== undefined) session.preferences = args.preferences;
    const party = args.party ?? session.conditions.party;
    session.conditions = {
      when: args.when,
      origin: args.origin,
      stay: args.stay,
      ...(party === undefined ? {} : { party }),
    };

    const today = ctx.today();
    const ranges = searchRanges(args.when, today);
    const pool = ranges.expanded
      ? ctx.festivals.onDates(ranges.expanded.from, ranges.expanded.to)
      : [];
    const result = searchFestivalDates(pool, {
      wish: args.when,
      today,
      origin: args.origin,
      stay: args.stay,
      preferences: session.preferences,
      ...(args.maxTravelMinutes === undefined ? {} : { maxTravelMinutes: args.maxTravelMinutes }),
    });

    const candidates: FestivalCandidate[] = result.matches.map(toCandidate);
    session.candidates = candidates;
    ctx.turn.searched = true;

    const notes: string[] = [];
    if (ranges.wish === null) notes.push("希望の日はすでに過ぎています。別の日を聞いてください");
    if (result.tooFar.length > 0) {
      notes.push(`日帰りの移動の上限を超える祭りを${result.tooFar.length}件除きました`);
    }
    if (candidates.length === 0) notes.push("条件に合う祭りはデータにありませんでした");

    return {
      today,
      searchedRange: ranges,
      candidates,
      details: result.matches.map((m) => ({
        festivalId: m.festival.id,
        category: m.festival.category,
        scaleTier: m.festival.scaleTier,
        popularity: m.festival.popularity,
        highlights: m.festival.highlights,
        localFood: m.festival.food.local.map((f) => f.name),
        stalls: m.festival.food.stalls,
        rainPolicy: m.occurrence.rainPolicy,
        status: m.occurrence.status,
        travelMinutesEstimate: m.travelMinutes,
        arrivalBufferMinutes: arrivalBufferMinutes(m.festival),
        participation: m.festival.etiquette.participation,
      })),
      notes,
    };
  },
});

export const searchNearby = defineTool({
  name: "search_nearby",
  description:
    "祭りの前後に寄れる観光・食・休憩の場所を、祭りのデータの周辺の場所から探す。" +
    "当日が休業の場所、使える時間帯に営業時間が合わない場所、「屋台で十分」のときの店は除き、こだわりに合う順に返す。",
  input: {
    festivalId: SlugSchema.describe("祭りの ID"),
    date: IsoDateSchema.optional().describe("行く日。省略すると候補や旅程の日"),
    window: z
      .object({ from: LocalTimeSchema, to: LocalTimeSchema })
      .optional()
      .describe("寄り道に使える時間帯（HH:MM）"),
    preferences: PreferencesSchema.optional().describe("省略すると相談のこだわりを使う"),
  },
  async run(args, ctx) {
    const festival = festivalOf(ctx, args.festivalId);
    const date = visitDate(ctx, festival, args.date);
    if (args.preferences !== undefined) ctx.session.preferences = args.preferences;
    ctx.session.selectedFestivalId = festival.id;
    const selection = selectNearbySpots(festival.nearby, {
      date,
      preferences: ctx.session.preferences,
      ...(args.window === undefined ? {} : { window: args.window }),
    });
    return {
      festivalId: festival.id,
      date,
      spots: selection.spots.map((s) => ({
        spotId: s.id,
        name: s.name,
        kind: s.kind,
        summary: s.summary,
        location: s.location,
        walkMinutesFromVenueEstimate: s.walkMinutesFromVenue,
        hours: s.hours,
        closedDays: s.closedDays,
        price: s.price,
        tags: s.tags,
        popularity: s.popularity,
        sources: s.sources,
      })),
      excluded: selection.excluded,
      localFood: festival.food.local.map((f) => ({ name: f.name, note: f.note ?? null })),
      stalls: festival.food.stalls,
      rules: preferenceEffects(ctx.session.preferences).rules,
    };
  },
});

export const getAccess = defineTool({
  name: "get_access",
  description:
    "出発地から祭りの会場への行き方の目安を、保存してある公式のアクセス案内から返す。" +
    "最寄り駅と徒歩、主要駅からの所要時間、駐車場、交通規制。時間はすべて目安。",
  input: {
    festivalId: SlugSchema.describe("祭りの ID"),
    origin: z.string().trim().min(1).max(50).optional().describe("出発地。省略すると相談の出発地"),
    move: z.enum(MOVE_MODES).optional().describe("train 電車 / car 車。省略すると相談のこだわり"),
  },
  async run(args, ctx) {
    const festival = festivalOf(ctx, args.festivalId);
    const origin = args.origin ?? ctx.session.conditions.origin ?? null;
    const move = args.move ?? ctx.session.preferences.move;
    const { access } = festival;
    const hub = origin === null ? undefined : matchHub(access, origin);
    const notes: string[] = [];
    if (hub === undefined) {
      notes.push("出発地からの所要時間はデータにありません。主要駅からの目安を使ってください");
    }
    if (move === "car") {
      if (access.parking === "none") {
        notes.push("会場の近くに駐車場がありません。電車で行くことをすすめてください");
      } else if (access.parking === "limited") {
        notes.push("駐車場は限られています。早めに着くか、電車も考えるよう伝えてください");
      } else if (access.parking === "unknown") {
        notes.push("駐車場の有無はデータにありません");
      }
    }
    return {
      festivalId: festival.id,
      venue: festival.venue,
      move,
      estimate: true,
      stations: access.stations.map((s) => ({ ...s, walkMinutesEstimate: s.walkMinutes })),
      fromOrigin:
        hub === undefined
          ? null
          : {
              hub: hub.hub,
              route: hub.route ?? null,
              trainMinutesEstimate: hub.minutes,
              doorToVenueMinutesEstimate: origin ? travelMinutesFrom(access, origin) : null,
            },
      fromHubs: access.fromHubs,
      parking: access.parking,
      trafficRestrictions: access.trafficRestrictions,
      arrivalBufferMinutes: arrivalBufferMinutes(festival),
      sources: access.sources,
      notes,
    };
  },
});

export const getWeather = defineTool({
  name: "get_weather",
  description:
    "祭りの開催地の、旅の日の天気を気象庁の予報から返す。予報の範囲より先の日は「予報前」（not_yet）になる。",
  input: {
    festivalId: SlugSchema.describe("祭りの ID（開催地に使う）"),
    date: IsoDateSchema.optional().describe("旅の日。省略すると候補や旅程の日"),
  },
  async run(args, ctx) {
    const festival = festivalOf(ctx, args.festivalId);
    const date = visitDate(ctx, festival, args.date);
    const prefecture = festival.municipalities[0]?.prefecture;
    const report =
      prefecture === undefined
        ? { weather: { status: "unavailable" } as Weather, area: null }
        : await ctx.weather.forecast(prefecture, date, ctx.today());
    ctx.session.weather.set(weatherKey(festival.id, date), report.weather);
    return { festivalId: festival.id, date, area: report.area, weather: report.weather };
  },
});

export const updateItinerary = defineTool({
  name: "update_itinerary",
  description:
    "旅程の全体を保存する。祭りの時間を先に固定し、前後の予定を時刻順に並べて渡す。" +
    "場所・営業時間・出典は祭りのデータで入れ直す。予定の重なり、営業時間の外、休業日、祭りの時間とのぶつかり、" +
    "到着の余裕の不足があれば保存せず errors を返すので、直してもう一度呼ぶ。修正のときも全体を渡す（予定の id は版をまたいで同じにする）。",
  input: {
    itinerary: ItineraryDraftSchema.describe(
      "旅程の全体（id・version・verification・weather はサーバーが付ける）",
    ),
  },
  async run(args, ctx) {
    const { session } = ctx;
    const previous = session.itineraryId
      ? (ctx.itineraries.get(session.itineraryId) ?? null)
      : null;
    const draft: ItineraryDraft = {
      ...(args.itinerary as ItineraryDraft),
      // こだわりは相談の状態を正とする
      preferences: session.preferences,
    };
    const main = ctx.festivals.get(draft.mainFestivalId);
    let weather = session.weather.get(weatherKey(draft.mainFestivalId, draft.date));
    if (weather === undefined && main !== undefined) {
      const prefecture = main.municipalities[0]?.prefecture;
      weather =
        prefecture === undefined
          ? { status: "unavailable" }
          : (await ctx.weather.forecast(prefecture, draft.date, ctx.today())).weather;
      session.weather.set(weatherKey(draft.mainFestivalId, draft.date), weather);
    }

    const result = buildItinerary(draft, {
      id: previous?.id ?? randomId("trip"),
      previous,
      weather: weather ?? { status: "unavailable" },
      findFestival: (id) => ctx.festivals.get(id),
    });
    if (!result.ok) {
      return { saved: false, errors: result.errors, warnings: result.warnings };
    }
    if (!result.unchanged) {
      ctx.itineraries.save(result.itinerary);
      session.itineraryId = result.itinerary.id;
      session.selectedFestivalId = result.itinerary.mainFestivalId;
      ctx.turn.savedItinerary = true;
    }
    return {
      saved: !result.unchanged,
      unchanged: result.unchanged,
      itineraryId: result.itinerary.id,
      version: result.itinerary.version,
      diff: result.diff,
      errors: [],
      warnings: result.warnings,
      itinerary: result.itinerary,
    };
  },
});

export const verifyFestival = defineTool({
  name: "verify_festival",
  description:
    "利用者が「決定」と言ったあとに、主役の祭りの開催予定を公式の情報で確かめ直す。" +
    "結果は as_planned（予定どおり）/ changed（変更）/ cancelled（中止）/ not_found（確認できず）。" +
    "確認できなかったときは確定させない。",
  input: {
    festivalId: SlugSchema.describe("祭りの ID"),
    date: IsoDateSchema.optional().describe("行く日。省略すると旅程の日"),
  },
  async run(args, ctx, signal) {
    const festival = festivalOf(ctx, args.festivalId);
    const date = visitDate(ctx, festival, args.date);
    const report = await ctx.verifier.verify({ festival, date, signal });
    const decision = decideVerification(festival, report, ctx.today());
    const checkedAt = ctx.now();
    const verification = {
      status: decision.result,
      checkedAt,
      sources: decision.sources,
      ...(decision.note ? { note: decision.note } : {}),
    };

    const itinerary = ctx.session.itineraryId
      ? ctx.itineraries.get(ctx.session.itineraryId)
      : undefined;
    if (
      itinerary !== undefined &&
      itinerary.mainFestivalId === festival.id &&
      itinerary.date === date
    ) {
      ctx.itineraries.save({ ...itinerary, verification });
    }
    ctx.turn.verification = decision.result;
    if (decision.result === "changed" || decision.result === "cancelled") {
      // 次のデータの更新で優先して調べ直すための、食い違いの記録（会話の文は残さない）
      console.warn(
        JSON.stringify({
          kind: "festival_discrepancy",
          festivalId: festival.id,
          date,
          result: decision.result,
          checkedAt,
          sources: decision.sources.map((s) => s.url),
        }),
      );
    }
    return {
      festivalId: festival.id,
      date,
      result: decision.result,
      checkedAt,
      sources: decision.sources,
      ...(decision.note ? { note: decision.note } : {}),
      daysUntil: daysBetween(ctx.today(), date),
      occurrenceInData: occurrenceOn(festival, date),
    };
  },
});

export const MATSURI_TOOLS: readonly MatsuriTool[] = [
  searchFestivals,
  searchNearby,
  getAccess,
  getWeather,
  updateItinerary,
  verifyFestival,
];

/** 地図に打つ場所（tool.end の spots）を、search_nearby の結果から作る */
export function spotPins(output: unknown): SpotPin[] {
  const spots = (output as { spots?: unknown })?.spots;
  if (!Array.isArray(spots)) return [];
  return spots.flatMap((s) => {
    const spot = s as Partial<SpotPin> & { spotId?: string };
    return spot.spotId && spot.name && spot.kind && spot.location
      ? [{ spotId: spot.spotId, name: spot.name, kind: spot.kind, location: spot.location }]
      : [];
  });
}
