import {
  DateWishSchema,
  type Festival,
  type FestivalCandidate,
  type IsoDate,
  IsoDateSchema,
  ItineraryDaySchema,
  ItineraryItemSchema,
  ItinerarySchema,
  LocalTimeSchema,
  MAX_TRIP_DAYS,
  MOVE_MODES,
  mainFestivalDay,
  NightsSchema,
  PartialTripConditionsSchema,
  PartySchema,
  PreferencesSchema,
  SlugSchema,
  type SpotPin,
  StayPlanSchema,
  type Weather,
} from "@matsuri-ikoka/schema";
import { z } from "zod";
import { arrivalBufferMinutes } from "../domain/arrivalBuffer";
import { daysBetween, laterDate } from "../domain/calendar";
import {
  matchHub,
  placeLabel,
  searchFestivalDates,
  searchRanges,
  toCandidate,
  travelMinutesFrom,
} from "../domain/dateWindow";
import {
  festivalOpenDaysAround,
  type HearingSituation,
  hearingFieldLabel,
  planHearing,
} from "../domain/hearing";
import {
  buildItinerary,
  draftFromItinerary,
  type ItineraryDayDraft,
  type ItineraryDraft,
  mergeDay,
} from "../domain/itinerary";
import { festivalInArea, selectNearbySpots } from "../domain/nearby";
import { occurrenceOn } from "../domain/planCheck";
import { preferenceEffects } from "../domain/preferences";
import { decideVerification } from "../domain/verification";
import { randomId } from "../session/sessionStore";
import type { CandidateCheck } from "./candidateCheck";
import { type AgentToolName, TOOL_TIMEOUT_MS, type ToolContext } from "./context";

// 接客エージェントに渡す7つのツール。入出力は Zod で決め、計算と絞り込みは domain の関数で行う。
// 祭りの日時・場所・営業時間・出典は、祭りのデータとツールの結果だけから返す。

/** ツールの失敗。message はエージェントに返す（利用者にそのまま見せる文ではない） */
export class ToolError extends Error {}

export interface MatsuriTool {
  name: AgentToolName;
  description: string;
  input: z.ZodRawShape;
  timeoutMs: number;
  run(args: unknown, ctx: ToolContext, signal: AbortSignal): Promise<Record<string, unknown>>;
}

function defineTool<Shape extends z.ZodRawShape, Output extends Record<string, unknown>>(def: {
  name: AgentToolName;
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
  if (itinerary?.mainFestivalId === festival.id) return mainFestivalDay(itinerary).date;
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

/** 下書きの1日。天気はサーバーが付ける */
const ItineraryDayDraftSchema = z
  .strictObject({
    ...ItineraryDaySchema.shape,
    items: z.array(ItineraryItemDraftSchema).min(1),
    stay: StayPlanSchema.nullable(),
  })
  .omit({ weather: true });

/** 旅程係が書く下書き。ID・版・再確認・天気はサーバーが付ける */
export const ItineraryDraftSchema = z
  .strictObject({
    ...ItinerarySchema.shape,
    days: z.array(ItineraryDayDraftSchema).min(1).max(MAX_TRIP_DAYS),
  })
  .omit({ id: true, version: true, verification: true });

/** 聞き取りの場面（祭りを選んだか、その祭りが旅の間に何日も開かれるか）を、相談の状態から決める */
export function hearingSituation(ctx: ToolContext): HearingSituation {
  const { session } = ctx;
  const festivalId = session.selectedFestivalId;
  if (festivalId === null) return {};
  const festival = ctx.festivals.get(festivalId);
  const date = session.candidates.find((c) => c.festivalId === festivalId)?.date;
  const nights = session.conditions.nights ?? 0;
  return {
    festivalChosen: true,
    multiDayFestival:
      festival !== undefined &&
      date !== undefined &&
      festivalOpenDaysAround(festival, date, nights) > 1,
  };
}

/** 次に聞くことを、エージェントが読める形にする */
export function hearingReport(ctx: ToolContext) {
  const plan = planHearing(ctx.session.conditions, hearingSituation(ctx));
  return {
    readyToSearch: plan.readyToSearch,
    readyToPlan: plan.readyToPlan,
    stillUnknown: plan.missing.map(hearingFieldLabel),
    askNext: plan.ask.map(hearingFieldLabel),
  };
}

/** 候補の祭りと日付ごとに、開催を確かめる。終わったものから festival.verified で画面に送る */
async function checkCandidates(
  ctx: ToolContext,
  matches: readonly { festival: Festival; date: IsoDate }[],
): Promise<(CandidateCheck | null)[]> {
  const checker = ctx.candidateChecks;
  if (checker === undefined) return matches.map(() => null);
  return Promise.all(
    matches.map(async ({ festival, date }) => {
      const check = await checker.check({
        festival,
        date,
        session: ctx.session,
        signal: ctx.signal,
      });
      if (check !== null && !ctx.signal.aborted) {
        ctx.emit?.({
          type: "festival.verified",
          data: {
            festivalId: check.festivalId,
            date: check.date,
            scope: "candidate",
            result: check.result,
            checkedAt: check.checkedAt,
            sources: check.sources,
            ...(check.note ? { note: check.note } : {}),
          },
        });
      }
      return check;
    }),
  );
}

/** エージェントに返す確かめの結果 */
function factCheckOf(check: CandidateCheck | null) {
  return check === null
    ? null
    : { result: check.result, note: check.note ?? null, sources: check.sources };
}

/** 候補に確かめの結果を付ける。公式で確かめられたら確認済み、変更・中止なら未確認にする */
function withCheck(candidate: FestivalCandidate, check: CandidateCheck | null): FestivalCandidate {
  if (check === null) return candidate;
  const confirmed =
    check.result === "as_planned"
      ? true
      : check.result === "changed" || check.result === "cancelled"
        ? false
        : candidate.confirmed;
  return {
    ...candidate,
    confirmed,
    check: { result: check.result, checkedAt: check.checkedAt },
  };
}

// ---------------------------------------------------------------------------

const NoteConditionsInputSchema = PartialTripConditionsSchema.extend({
  nights: NightsSchema.optional().describe(
    "泊数。0 は日帰り・週末のお出かけ。近場のお出かけと分かるときは 0",
  ),
  route: PartialTripConditionsSchema.shape.route.describe(
    "旅のかたち（stay ずっと一か所 / loop 地域を巡る / via 目的地へ向かう途中で寄る / auto おまかせ）と、回りたい地域の名前",
  ),
  returnTo: PartialTripConditionsSchema.shape.returnTo.describe(
    "旅の終わりの場所（駅名まで）。出発地に戻るなら出発地",
  ),
  interests: PartialTripConditionsSchema.shape.interests.describe(
    "祭りのほかに楽しみたいこと。特にない・おまかせなら空の並び",
  ),
  leaveToStaff: PartialTripConditionsSchema.shape.leaveToStaff.describe(
    "「あとはおまかせ」と言われたら true",
  ),
});

export const noteConditions = defineTool({
  name: "note_conditions",
  description:
    "お客さまの発言から読み取れた旅の条件を書き留め、まだ分からない項目と、次に聞くこと（1回に2つまで）を返す。" +
    "言われた項目だけを渡す（渡さない項目は前のまま）。自由な言葉から読み取れるものは読み取って渡し、推測では埋めない。" +
    "readyToSearch が true になったら祭りを探し始め、askNext の項目だけを聞く。",
  input: NoteConditionsInputSchema.shape,
  async run(args, ctx) {
    const given = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined),
    );
    const merged = PartialTripConditionsSchema.safeParse({ ...ctx.session.conditions, ...given });
    if (!merged.success) throw new ToolError("条件の形が正しくありません");
    ctx.session.conditions = merged.data;
    return { conditions: merged.data, ...hearingReport(ctx) };
  },
});

export const searchFestivals = defineTool({
  name: "search_festivals",
  description:
    "希望日（または期間）・出発地・泊数に合う祭りを、祭りのデータから最大3件探す。" +
    "希望日の祭りを先に並べ、足りなければ前後2週間で補い、希望日からのずれ（日）を付ける。" +
    "今日より前の日・中止・掲載停止の祭りは出ない。日帰り（0泊）は移動の上限を超える祭りを除く。",
  input: {
    when: DateWishSchema.describe(
      "希望日。1日なら {kind:'date',date}、期間なら {kind:'range',from,to}",
    ),
    origin: z.string().trim().min(1).max(50).describe("出発地（駅名まで）"),
    nights: NightsSchema.describe("泊数。0 は日帰り・週末のお出かけ、1〜6 は泊まりの旅"),
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
    // 聞き取りで書き留めたほかの条件（旅のかたち・ペースなど）は残す
    session.conditions = {
      ...session.conditions,
      when: args.when,
      origin: args.origin,
      nights: args.nights,
      ...(args.party === undefined ? {} : { party: args.party }),
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
      nights: args.nights,
      preferences: session.preferences,
      ...(args.maxTravelMinutes === undefined ? {} : { maxTravelMinutes: args.maxTravelMinutes }),
    });

    // 候補を出す前に、開催日・時刻・状態を公式の情報で確かめる（3件を並べて動かす）
    const checks = await checkCandidates(ctx, result.matches);
    const candidates: FestivalCandidate[] = result.matches.map((match, index) =>
      withCheck(toCandidate(match), checks[index] ?? null),
    );
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
      details: result.matches.map((m, index) => ({
        festivalId: m.festival.id,
        category: m.festival.category,
        scaleTier: m.festival.scaleTier,
        popularity: m.festival.popularity,
        highlights: m.festival.highlights,
        // 土地の味は、どこで食べられるかの補足も渡す（屋台の味と取り違えないため）
        localFood: m.festival.food.local.map((f) => ({ name: f.name, note: f.note ?? null })),
        stalls: m.festival.food.stalls,
        rainPolicy: m.occurrence.rainPolicy,
        status: m.occurrence.status,
        // 複数の日に開かれる祭りは、探す範囲の中のほかの日も渡す（日によって見どころが違う）
        daysInRange: m.festival.occurrences
          .filter(
            (o) =>
              o.status !== "cancelled" &&
              o.status !== "postponed" &&
              ranges.expanded !== null &&
              o.date <= ranges.expanded.to &&
              (o.endDate ?? o.date) >= ranges.expanded.from,
          )
          .map((o) => ({
            date: o.date,
            ...(o.endDate ? { endDate: o.endDate } : {}),
            start: o.start,
            end: o.end,
            note: o.note ?? null,
          })),
        travelMinutesEstimate: m.travelMinutes,
        // 候補を出す前の確かめ。null は確かめていない（上限や、確かめる手段がない）
        factCheck: factCheckOf(checks[index] ?? null),
        arrivalBufferMinutes: arrivalBufferMinutes(m.festival),
        participation: m.festival.etiquette.participation,
      })),
      notes,
    };
  },
});

/** 地域で探したときに返す場所の数の上限 */
const MAX_AREA_SPOTS = 12;

function spotOutput(s: Festival["nearby"][number]) {
  return {
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
  };
}

/** 地域で探す：その地域の祭りの周辺の場所と、その日にその地域で開かれる祭り（祭りのない日の行き先に使う） */
function searchArea(
  ctx: ToolContext,
  area: string,
  date: IsoDate,
  window: { from: string; to: string } | undefined,
) {
  const festivals = ctx.festivals.list().filter((f) => festivalInArea(f, area));
  const spots = festivals
    .flatMap((festival) =>
      selectNearbySpots(festival.nearby, {
        date,
        preferences: ctx.session.preferences,
        ...(window === undefined ? {} : { window }),
      }).spots.map((spot) => ({ ...spotOutput(spot), festivalId: festival.id })),
    )
    .slice(0, MAX_AREA_SPOTS);
  const festivalsOnDate = festivals.flatMap((festival) => {
    const occurrence = occurrenceOn(festival, date);
    if (occurrence === null || occurrence.status === "cancelled") return [];
    return [
      {
        festivalId: festival.id,
        name: festival.name.ja,
        place: placeLabel(festival),
        start: occurrence.start,
        end: occurrence.end,
        status: occurrence.status,
        sources: occurrence.sources,
      },
    ];
  });
  const notes: string[] = [];
  if (festivals.length === 0) notes.push("この地域の祭りと場所は、データにありません");
  if (spots.length === 0) {
    notes.push("寄れる場所がデータにありません。場所を作らず「自由に過ごす時間」にしてください");
  }
  return {
    area,
    date,
    spots,
    festivalsOnDate,
    rules: preferenceEffects(ctx.session.preferences).rules,
    notes,
  };
}

export const searchNearby = defineTool({
  name: "search_nearby",
  description:
    "祭りの前後に寄れる観光・食・休憩の場所を、祭りのデータの周辺の場所から探す。" +
    "当日が休業の場所、使える時間帯に営業時間が合わない場所、「屋台で十分」のときの店は除き、こだわりに合う順に返す。" +
    "祭りのない日の行き先は、festivalId の代わりに area（都道府県や市町村の名前）と date で探す。" +
    "その地域のほかの祭りの周辺の場所と、その日にその地域で開かれる祭りを返す（場所には持ち主の祭りの festivalId が付く）。",
  input: {
    festivalId: SlugSchema.optional().describe("祭りの ID。area と、どちらかを渡す"),
    area: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .describe("地域の名前（都道府県や市町村）。祭りのない日の行き先を探すとき"),
    date: IsoDateSchema.optional().describe(
      "行く日。省略すると候補や旅程の日。area で探すときは必ず渡す",
    ),
    window: z
      .object({ from: LocalTimeSchema, to: LocalTimeSchema })
      .optional()
      .describe("寄り道に使える時間帯（HH:MM）"),
    preferences: PreferencesSchema.optional().describe("省略すると相談のこだわりを使う"),
  },
  async run(args, ctx) {
    if (args.preferences !== undefined) ctx.session.preferences = args.preferences;
    if (args.festivalId === undefined) {
      if (args.area === undefined)
        throw new ToolError("festivalId か area のどちらかを渡してください");
      if (args.date === undefined) throw new ToolError("area で探すときは date を渡してください");
      return searchArea(ctx, args.area, args.date, args.window);
    }
    const festival = festivalOf(ctx, args.festivalId);
    const date = visitDate(ctx, festival, args.date);
    ctx.session.selectedFestivalId = festival.id;
    const selection = selectNearbySpots(festival.nearby, {
      date,
      preferences: ctx.session.preferences,
      ...(args.window === undefined ? {} : { window: args.window }),
    });
    return {
      festivalId: festival.id,
      date,
      spots: selection.spots.map(spotOutput),
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
    "旅程の全体を保存する。旅程は日ごとの予定（days、日帰り・お出かけは1日、泊まりの旅は続いた日付で最大7日）。" +
    "祭りの時間を先に固定し、前後の予定を時刻順に並べて渡す。泊まる日は stay に泊まる地域を書き、最後の日は stay を null にする。" +
    "場所・営業時間・出典は祭りのデータで入れ直す。予定の重なり、営業時間の外、休業日、祭りの時間とのぶつかり、" +
    "到着の余裕の不足があれば保存せず errors を返すので、直してもう一度呼ぶ。修正のときも全体を渡す（予定の id は版をまたいで同じにする）。" +
    "何日かの旅は1日ずつ書く：はじめに主役の祭りの日だけの旅程を itinerary で保存し、そのあと addDay で1日ずつ足す（同じ日付なら置き換える）。" +
    "後ろに足すときは、それまでの最後の日の夜に泊まる地域を stayBefore に書く。保存のたびに画面の旅程が更新される。",
  input: {
    itinerary: ItineraryDraftSchema.optional().describe(
      "旅程の全体（id・version・verification・日ごとの weather はサーバーが付ける）",
    ),
    addDay: z
      .strictObject({
        day: ItineraryDayDraftSchema.describe("足す日（または置き換える日）"),
        stayBefore: StayPlanSchema.optional().describe(
          "後ろに足すとき、それまでの最後の日の夜に泊まる地域",
        ),
      })
      .optional()
      .describe("保存した旅程に1日を足す。itinerary と、どちらかを渡す"),
  },
  async run(args, ctx, signal) {
    const { session } = ctx;
    const previous = session.itineraryId
      ? (ctx.itineraries.get(session.itineraryId) ?? null)
      : null;
    let written: ItineraryDraft;
    if (args.itinerary !== undefined) {
      written = args.itinerary as ItineraryDraft;
    } else if (args.addDay !== undefined) {
      if (previous === null) {
        throw new ToolError(
          "まだ旅程がありません。はじめに主役の祭りの日を itinerary で保存してください",
        );
      }
      const merged = mergeDay(
        draftFromItinerary(previous),
        args.addDay.day as ItineraryDayDraft,
        args.addDay.stayBefore,
      );
      if (!merged.ok) {
        return {
          saved: false,
          errors: [{ code: "invalid", itemId: null, message: merged.message }],
          warnings: [],
        };
      }
      written = merged.draft;
    } else {
      throw new ToolError("itinerary か addDay のどちらかを渡してください");
    }
    const draft: ItineraryDraft = {
      ...written,
      // こだわりは相談の状態を正とする
      preferences: session.preferences,
    };
    // 天気は日ごとに、その日の祭りの開催地（祭りのない日は主役の祭りの開催地）で調べる。
    // 調べた天気は相談に残し、気象庁の予報も地域ごとにキャッシュしているので、何日分でも軽い
    const weatherByDate = new Map<IsoDate, Weather>();
    for (const day of draft.days) {
      const festivalId =
        day.items.find((item) => item.type === "festival" && item.festivalId)?.festivalId ??
        draft.mainFestivalId;
      const key = weatherKey(festivalId, day.date);
      let weather = session.weather.get(key);
      const prefecture = ctx.festivals.get(festivalId)?.municipalities[0]?.prefecture;
      if (weather === undefined && prefecture !== undefined) {
        weather = (await ctx.weather.forecast(prefecture, day.date, ctx.today())).weather;
        session.weather.set(key, weather);
      }
      weatherByDate.set(day.date, weather ?? { status: "unavailable" });
    }

    const result = buildItinerary(draft, {
      id: previous?.id ?? randomId("trip"),
      previous,
      weatherFor: (date) => weatherByDate.get(date) ?? { status: "unavailable" },
      findFestival: (id) => ctx.festivals.get(id),
    });
    if (!result.ok) {
      // 旅程係の組み方の傾向をつかむため、断った理由の種類だけを残す（予定の名前や文は残さない）
      console.info(
        JSON.stringify({ kind: "itinerary_rejected", codes: result.errors.map((e) => e.code) }),
      );
      return { saved: false, errors: result.errors, warnings: result.warnings };
    }
    // 時間切れや接続の切断のあとに、旅程を書き換えない
    if (signal.aborted) throw new ToolError("止められたので、旅程は保存しません");
    if (!result.unchanged) {
      ctx.itineraries.save(result.itinerary);
      session.itineraryId = result.itinerary.id;
      session.selectedFestivalId = result.itinerary.mainFestivalId;
    }
    ctx.turn.savedItinerary = true;
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
    // 時間切れや接続の切断のあとに、再確認の結果で旅程を書き換えない
    if (signal.aborted) throw new ToolError("止められたので、再確認の結果は使いません");
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
    const applied =
      itinerary !== undefined &&
      itinerary.mainFestivalId === festival.id &&
      mainFestivalDay(itinerary).date === date;
    if (applied) {
      ctx.itineraries.save({ ...itinerary, verification });
      // 会話の状態（しおりへ進むか）は、旅程の再確認の結果を実際に書き換えたときだけ変える
      ctx.turn.verification = decision.result;
    }
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
      /** 旅程の再確認の結果を書き換えたか。主役の祭りと日付が旅程と違えば書き換えない */
      appliedToItinerary: applied,
      daysUntil: daysBetween(ctx.today(), date),
      occurrenceInData: occurrenceOn(festival, date),
    };
  },
});

export const MATSURI_TOOLS: readonly MatsuriTool[] = [
  noteConditions,
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
