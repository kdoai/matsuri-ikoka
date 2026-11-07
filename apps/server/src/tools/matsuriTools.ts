import { retryOnce } from "@matsuri-ikoka/agent-kit";
import {
  DateWishSchema,
  DestinationsSchema,
  type Festival,
  type FestivalCandidate,
  type IsoDate,
  IsoDateSchema,
  type Itinerary,
  ItineraryDaySchema,
  ItineraryItemSchema,
  ItinerarySchema,
  LastReturnSchema,
  type LatLng,
  LocalTimeSchema,
  type LodgingBudget,
  LodgingBudgetSchema,
  type LodgingSearch,
  MAX_CANDIDATES,
  MAX_NIGHTS,
  MAX_TRIP_DAYS,
  MaxTravelMinutesSchema,
  MEAL_SLOTS,
  MealPlanSchema,
  type MealSlot,
  MOVE_MODES,
  mainFestivalDay,
  type NearbySpot,
  type NearMiss,
  NightsSchema,
  PartialTripConditionsSchema,
  type Party,
  PartySchema,
  PreferencesSchema,
  RESEARCH_TARGETS,
  type SearchOutcome,
  SlugSchema,
  type Source,
  SourceSchema,
  type SpotPin,
  StayPlanSchema,
  tripBudgetAmounts,
  VerificationSchema,
  type Weather,
} from "@matsuri-ikoka/schema";
import { z } from "zod";
import { type AnchorIssue, checkAnchoredItinerary, refreshAnchorPlan } from "../domain/anchorPlan";
import { arrivalBufferMinutes } from "../domain/arrivalBuffer";
import { addDays, daysBetween, fromMinutes, laterDate, toMinutes } from "../domain/calendar";
import { matchHub, placeLabel, toCandidate, travelMinutesFrom } from "../domain/dateWindow";
import {
  DESTINATION_STAGES,
  destinationLabel,
  destinationQuestion,
  destinationReason,
  knownDestinationNames,
  resolveDestination,
} from "../domain/destination";
import { foodEffects } from "../domain/food";
import { type HearingSituation, hearingFieldLabel, planHearing } from "../domain/hearing";
import {
  buildItinerary,
  draftFromItinerary,
  type ItineraryDayDraft,
  type ItineraryDraft,
  mergeDay,
} from "../domain/itinerary";
import {
  attachLodging,
  checkLodgingBudget,
  distanceKm,
  perPersonNightLimitYen,
} from "../domain/lodging";
import {
  lodgingFromVenue,
  lodgingSearchPlans,
  screenResearchedLodging,
  VENUE_LODGING_KM,
} from "../domain/lodgingResearch";
import {
  festivalInArea,
  mealCandidates,
  selectNearbySpots,
  stallsServeLunch,
  type TimeWindow,
} from "../domain/nearby";
import {
  asNearbySpot,
  type ResearchedSpot,
  type ResearchedSpotReport,
  researchedSpotsInItinerary,
  screenResearchedSpots,
  shopFoodWishes,
} from "../domain/nearbyResearch";
import {
  maxSpotKm,
  mergeResearchedReports,
  type NearbySearchInput,
  type NearbySearchRound,
  nearbySearchPlan,
  nearbySearchPlans,
  SPARSE_SHOP_COUNT,
  SPARSE_SPOT_KM,
  searchRadiusKm,
  WALK_SPOT_KM,
} from "../domain/nearbySearch";
import { OSM_ATTRIBUTION, osmLodgingOffers, osmSpotReport } from "../domain/osmPlaces";
import { occurrenceOn } from "../domain/planCheck";
import { MEAL_WINDOWS, type ResearchedPlace } from "../domain/planCoverage";
import { preferenceEffects } from "../domain/preferences";
import {
  excludedCounts,
  nearMissesOf,
  runSearch,
  type SearchDeps,
  type SearchQuery,
  suggestNextSteps,
  withinConditions,
} from "../domain/searchConditions";
import { transportEffects } from "../domain/transport";
import {
  checkDayTripLimit,
  checkResearchedMinutes,
  checkStartsAtOrigin,
  estimateTravel,
  normalizeStationName,
  type TravelEstimate,
} from "../domain/travelEstimate";
import { decideVerification } from "../domain/verification";
import { randomId } from "../session/sessionStore";
import type { CandidateCheck } from "./candidateCheck";
import {
  type AgentToolName,
  type Settled,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type TripPrefetch,
} from "./context";
import { type LodgingOutcome, MAX_SEARCH_RADIUS_KM, RAKUTEN_CREDIT } from "./lodging";
import {
  canRedoPlan,
  nextStepAfter,
  redoAcceptEvent,
  redoRequestEvents,
  reviewPlan,
} from "./planReview";
import type { RouteDirection } from "./routeResearch";

// 接客エージェントに渡すツール。入出力は Zod で決め、計算と絞り込みは domain の関数で行う。
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

/** 出した候補（なければ、条件を1つだけ外せば出る祭り）から祭りを引く */
function knownCandidate(ctx: ToolContext, festivalId: string): FestivalCandidate | undefined {
  const { candidates, nearMisses } = ctx.session;
  return (
    candidates.find((c) => c.festivalId === festivalId) ??
    nearMisses.find((c) => c.festivalId === festivalId)
  );
}

/** 日付の指定がないとき、その祭りへ行く日を、候補・旅程・開催回から決める */
function visitDate(ctx: ToolContext, festival: Festival, given?: IsoDate): IsoDate {
  if (given !== undefined) return given;
  const { anchor } = ctx.session;
  if (anchor?.festivalId === festival.id) return anchor.date;
  const itinerary = ctx.session.itineraryId
    ? ctx.itineraries.get(ctx.session.itineraryId)
    : undefined;
  if (itinerary?.mainFestivalId === festival.id) return mainFestivalDay(itinerary).date;
  const candidate = knownCandidate(ctx, festival.id);
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

/** 出発の駅から会場までの所要時間の目安（駅の位置がなければ、データの主要駅からの所要時間だけ） */
function travelEstimateFor(
  ctx: ToolContext,
  festival: Festival,
  origin: string,
): TravelEstimate | null {
  if (ctx.stations !== undefined) {
    return estimateTravel({ access: festival.access, venue: festival.venue, origin }, ctx.stations);
  }
  const minutes = travelMinutesFrom(festival.access, origin);
  return minutes === null ? null : { minutes, basis: "data", nearestStation: null, viaHub: null };
}

/** 会場の最寄り駅の名前。データのアクセス案内の最初の駅、なければ駅の位置でいちばん近い駅 */
function destinationStation(ctx: ToolContext, festival: Festival): string | null {
  const listed = festival.access.stations[0]?.name;
  if (listed !== undefined) return listed;
  return ctx.stations?.nearest({ lat: festival.venue.lat, lng: festival.venue.lng })?.name ?? null;
}

export const ItineraryItemDraftSchema = z
  .strictObject({ ...ItineraryItemSchema.shape })
  .omit({ changedInVersion: true });

const DraftSourcesSchema = z
  .array(SourceSchema)
  .default([])
  .describe("読んだページの出典。店の場所と祭りの屋台の出典はサーバーが入れ直す");

/**
 * 下書きの1日。天気はサーバーが付ける。
 * 食事の案と帰りの最終の出典は、保存のときにサーバーが入れ直す（残らなければ、案を外すか時刻を「分からない」にする）。
 * なので、ここでは出典がなくても断らない。断ると旅程の全体を書き直すことになり、時間と費用がむだになる
 */
const ItineraryDayDraftSchema = z
  .strictObject({
    ...ItineraryDaySchema.shape,
    items: z.array(ItineraryItemDraftSchema).min(1),
    stay: StayPlanSchema.nullable(),
    meals: z
      .array(z.strictObject({ ...MealPlanSchema.shape, sources: DraftSourcesSchema }))
      .max(4)
      .optional(),
    lastReturn: z
      .strictObject({ ...LastReturnSchema.shape, sources: DraftSourcesSchema })
      .nullable()
      .optional(),
  })
  .omit({ weather: true });

/** 旅程係が書く下書き。ID・版・再確認・天気はサーバーが付ける */
export const ItineraryDraftSchema = z
  .strictObject({
    ...ItinerarySchema.shape,
    days: z.array(ItineraryDayDraftSchema).min(1).max(MAX_TRIP_DAYS),
  })
  .omit({
    id: true,
    version: true,
    verification: true,
    budget: true,
    gaps: true,
    evaluation: true,
  })
  // 今の旅程を写して渡されたときに断らないよう、サーバーが付ける項目は受け取って捨てる
  .extend({
    gaps: z.unknown().optional().describe("サーバーが付ける。書かない（書いても使わない）"),
    evaluation: z.unknown().optional().describe("サーバーが付ける。書かない（書いても使わない）"),
    considered: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(100).describe("場所の ID（spotId か宿の候補の id）"),
          reason: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .describe("採った理由、または採らなかった理由（1文）"),
        }),
      )
      .max(40)
      .optional()
      .describe("周辺係・宿の係が見つけた場所の採否の理由。採ったかと名前はサーバーが決める"),
  });

/** 聞き取りの場面（祭りを選んだか、祭りを固定しているか）を、相談の状態から決める */
export function hearingSituation(ctx: ToolContext): HearingSituation {
  const { session } = ctx;
  if (session.selectedFestivalId === null) return {};
  return { festivalChosen: true, anchored: session.anchor !== null };
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

/**
 * 祭りを固定した旅程で、組み始める前に開催を確かめる（確かめは1回だけ。候補と同じ口で、結果はとってある）。
 * 中止と分かったら固定を外し、旅程を組まずに結果へ戻す。ほかの結果は店の記録に載せてそのまま進める
 */
export async function confirmAnchor(ctx: ToolContext): Promise<void> {
  const { session } = ctx;
  const { anchor } = session;
  if (anchor === null || session.anchorCheck !== null) return;
  const festival = ctx.festivals.get(anchor.festivalId);
  if (festival === undefined) return;
  const [check] = await checkCandidates(ctx, [{ festival, date: anchor.date }]);
  if (check === undefined || check === null || ctx.signal.aborted) return;
  session.anchorCheck = check.result;
  if (check.result !== "cancelled") return;
  session.cancelledAnchor = { ...anchor, name: festival.name.ja, note: check.note ?? null };
  releaseAnchor(ctx);
  ctx.turn.verification = "cancelled";
}

/** 祭りの固定を外す（別の祭りを選び直すとき） */
function releaseAnchor(ctx: ToolContext): void {
  const { session } = ctx;
  session.anchor = null;
  session.anchorPlan = null;
  session.selectedFestivalId = null;
  ctx.turn.anchorReleased = true;
}

/** 相談の条件が変わったら、固定した祭りの組み立てを計算し直す */
function refreshAnchor(ctx: ToolContext): void {
  const { session } = ctx;
  if (session.anchor === null) return;
  refreshAnchorPlan(session, {
    festival: ctx.festivals.get(session.anchor.festivalId),
    stations: ctx.stations,
    today: ctx.today(),
  });
}

/**
 * 候補を選ぶ前に開催を確かめる数。情報の取れない祭りは出さないので、出す数（3件）の倍を確かめる
 */
export const CANDIDATE_CHECK_POOL = MAX_CANDIDATES * 2;

/**
 * 確かめの結果で候補を選び直す。
 * - 中止と分かった祭りと、どこからも開催の情報が取れなかった祭り（not_found）は出さない
 * - requireInfo のとき（確かめる手段があるとき）は、確かめられず（上限など）データでも確認済みでない祭りも出さない
 * - 公式で確かめられた祭り（確かめていなければ、データで確認済みの祭り）を先に、要事前確認、変更のあった祭りの順
 * 同じ段の中は、日程とこだわりで並べた元の順を保つ
 */
export function pickVerifiedCandidates<T extends { confirmed: boolean }>(
  items: readonly { match: T; check: CandidateCheck | null }[],
  limit: number,
  options: { requireInfo?: boolean } = {},
): { match: T; check: CandidateCheck | null }[] {
  const tier = ({ match, check }: { match: T; check: CandidateCheck | null }) => {
    if (check === null) return match.confirmed ? 0 : 1;
    return check.result === "as_planned" ? 0 : check.result === "needs_check" ? 1 : 2;
  };
  return items
    .filter(({ match, check }) => {
      if (check === null) return !options.requireInfo || match.confirmed;
      return check.result !== "cancelled" && check.result !== "not_found";
    })
    .map((item, index) => ({ item, index }))
    .sort((a, b) => tier(a.item) - tier(b.item) || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

/** エージェントに返す確かめの結果 */
function factCheckOf(check: CandidateCheck | null) {
  return check === null
    ? null
    : { result: check.result, note: check.note ?? null, sources: check.sources };
}

/**
 * 候補に確かめの結果を付ける。公式で確かめられたら確認済み。要事前確認・変更・中止は確認済みにしない
 * （要事前確認の祭りは、画面で「要事前確認」と出して選べるようにする）
 */
function withCheck(candidate: FestivalCandidate, check: CandidateCheck | null): FestivalCandidate {
  if (check === null) return candidate;
  const confirmed =
    check.result === "as_planned"
      ? true
      : check.result === "not_found"
        ? candidate.confirmed
        : false;
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
  foodWishes: PartialTripConditionsSchema.shape.foodWishes.describe(
    "旅先で食べたいもの。こだわらない・おまかせなら空の並び",
  ),
  dietary: PartialTripConditionsSchema.shape.dietary.describe(
    "食事で気をつけたいこと（ベジタリアン・アレルギーなど）。言われたときだけ。アレルギーの中身は書き留めない",
  ),
  transport: PartialTripConditionsSchema.shape.transport.describe(
    "想定している交通手段（車・新幹線・在来線・バス・船・飛行機・レンタカー・徒歩）。おまかせなら空の並び",
  ),
  leaveToStaff: PartialTripConditionsSchema.shape.leaveToStaff.describe(
    "「あとはおまかせ」と言われたら true",
  ),
  budget: PartialTripConditionsSchema.shape.budget.describe(
    "旅全体の予算の上限（円）と単位（perPerson 1人あたり / total 全員の合計）。言われた単位のまま渡す（自分で割ったり掛けたりしない）",
  ),
  maxTravelMinutes: PartialTripConditionsSchema.shape.maxTravelMinutes.describe(
    "日帰りの片道の所要時間の上限（分）。「出発の駅から1時間以内」なら 60。言われたときだけ",
  ),
  destinations: PartialTripConditionsSchema.shape.destinations.describe(
    "行き先（都道府県か地方の名前。例：「富山県」「北陸」「近畿」）。言われた名前のまま渡す。どこでもよい・おまかせなら空の並び",
  ),
  releaseAnchor: z
    .literal(true)
    .optional()
    .describe(
      "祭りを固定した旅程で、ほかの祭りに変えたいと言われたら true。固定を外して結果へ戻る",
    ),
});

/** 行き先の名前を都道府県に直す。都道府県にも地方にも当たらない名前はエージェントに返す */
function destinationOf(names: readonly string[]) {
  const resolved = resolveDestination(names);
  if (resolved.unknown.length > 0) {
    throw new ToolError(
      `行き先「${resolved.unknown.join("・")}」は都道府県か地方の名前で渡してください（使える名前：${knownDestinationNames().join("・")}）`,
    );
  }
  return resolved.prefectures;
}

export const noteConditions = defineTool({
  name: "note_conditions",
  description:
    "お客さまの発言から読み取れた旅の条件を書き留め、まだ分からない項目と、次に聞くこと（1回に2つまで）を返す。" +
    "言われた項目だけを渡す（渡さない項目は前のまま）。自由な言葉から読み取れるものは読み取って渡し、推測では埋めない。" +
    "readyToSearch が true になったら祭りを探し始め、askNext の項目だけを聞く。" +
    "祭りを固定した旅程では、条件が変わるとサーバーが組み立てを計算し直す（行く日は変わらない）。",
  input: NoteConditionsInputSchema.shape,
  async run(args, ctx) {
    const { releaseAnchor: release, ...noted } = args;
    const given = Object.fromEntries(
      Object.entries(noted).filter(([, value]) => value !== undefined),
    );
    if (args.destinations !== undefined) destinationOf(args.destinations);
    const merged = PartialTripConditionsSchema.safeParse({ ...ctx.session.conditions, ...given });
    if (!merged.success) throw new ToolError("条件の形が正しくありません");
    ctx.session.conditions = merged.data;
    if (release === true) releaseAnchor(ctx);
    refreshAnchor(ctx);
    return { conditions: ctx.session.conditions, ...hearingReport(ctx) };
  },
});

export const searchFestivals = defineTool({
  name: "search_festivals",
  description:
    "希望日（または期間）・出発地・泊数に合う祭りを、祭りのデータから最大3件探す。" +
    "条件（希望の日程・日帰りの片道の所要時間・行き先）はコードで確かめ、すべて合う祭りだけを候補にする。" +
    "今日より前の日・中止・掲載停止の祭りは出ない。候補が0件なら search.status が none になり、" +
    "条件を1つだけ外せば出る祭り（search.nearMisses、外れている点つき）と、次の手（search.suggestions）を返す。" +
    "行き先があれば、その地域の祭りだけを出す。地域になければ候補を出さずに destination.question を返すので、" +
    "その問いをお客さまに聞き、了承を得てから widen を広げて探し直す。",
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
    maxTravelMinutes: MaxTravelMinutesSchema.optional().describe(
      "日帰りの片道の所要時間の上限（分）。利用者が言ったときだけ。省略すると相談で書き留めた上限。泊まりの旅では使わない",
    ),
    destinations: DestinationsSchema.optional().describe(
      "行き先（都道府県か地方の名前）。省略すると相談で書き留めた行き先。空の並びはおまかせ（どこでも）",
    ),
    widen: z
      .enum(DESTINATION_STAGES)
      .optional()
      .describe(
        "行き先をどこまで広げてよいか。area 選んだ地域だけ（既定）/ neighbor 隣接する県まで / nationwide 全国からランダムに。" +
          "お客さまが destination.question に了承したときだけ広げる",
      ),
  },
  async run(args, ctx) {
    const { session } = ctx;
    if (session.anchor !== null) {
      throw new ToolError(
        "お客さまは祭りを決めています（店の記録の「必ず行く祭り」）。祭りを探さず、周辺係と旅程係へ進んでください",
      );
    }
    if (args.preferences !== undefined) session.preferences = args.preferences;
    // 候補の窓の次の手（ボタン）から探し直すときは、ボタンの条件を正とする（モデルの渡した値より先に使う）
    const retry = ctx.turn.searchRetry;
    const when = retry?.when ?? args.when;
    const nights = retry?.nights ?? args.nights;
    const maxTravelMinutes =
      retry?.maxTravelMinutes ?? args.maxTravelMinutes ?? session.conditions.maxTravelMinutes;
    const widen = retry?.widen ?? args.widen ?? "area";
    const destinations = args.destinations ?? session.conditions.destinations ?? [];
    const prefectures = destinationOf(destinations);
    // 聞き取りで書き留めたほかの条件（旅のかたち・ペースなど）は残す
    session.conditions = {
      ...session.conditions,
      when,
      origin: args.origin,
      nights,
      ...(args.party === undefined ? {} : { party: args.party }),
      ...(maxTravelMinutes === undefined ? {} : { maxTravelMinutes }),
      ...(args.destinations === undefined ? {} : { destinations: args.destinations }),
    };

    const today = ctx.today();
    const stations = ctx.stations;
    const origin = args.origin;
    const label = destinationLabel(destinations);
    const query: SearchQuery = {
      when,
      origin,
      nights,
      ...(maxTravelMinutes === undefined ? {} : { maxTravelMinutes }),
      prefectures,
      destinationLabel: label,
      widen,
      preferences: session.preferences,
    };
    const searchDeps: SearchDeps = {
      today,
      festivalsOn: (from, to) => ctx.festivals.onDates(from, to),
      // 出発の駅の位置から、会場までの所要時間を見積もる（データに出発の駅からの所要時間がない祭りにも使う）
      ...(stations === undefined
        ? {}
        : {
            travelFor: (festival: Festival) =>
              estimateTravel({ access: festival.access, venue: festival.venue, origin }, stations),
          }),
      random: ctx.random ?? Math.random,
    };

    // 条件（日程・片道の所要時間・行き先）に照らし、すべて合う祭りだけを候補にする
    const attempt = runSearch(query, searchDeps);
    const ranges = attempt.ranges;
    const poolSize = ctx.candidateChecks === undefined ? MAX_CANDIDATES : CANDIDATE_CHECK_POOL;
    const pool = attempt.fits.slice(0, poolSize);

    // 候補を出す前に、開催日・時刻・状態を公式の情報で確かめる（並べて動かす）。
    // 出す数より多めに確かめ、確かめられた祭りを先に選ぶ
    const pooledChecks = await checkCandidates(ctx, pool);
    const picked = pickVerifiedCandidates(
      pool.map((match, index) => ({ match, check: pooledChecks[index] ?? null })),
      MAX_CANDIDATES,
      { requireInfo: ctx.candidateChecks !== undefined },
    );
    // 出す直前に、候補の形の値で条件を確かめ直す。合わないものが混じっていたら出さない
    const shown = picked
      .map((p) => ({
        ...p,
        candidate: withCheck({ ...toCandidate(p.match), travel: p.match.travel }, p.check),
      }))
      .filter((p) =>
        withinConditions(p.candidate, ctx.festivals.get(p.candidate.festivalId), query),
      );
    const candidates = shown.map((p) => p.candidate);
    session.candidates = candidates;
    ctx.turn.searched = true;

    // 条件を1つだけ外せば出る祭りと、次の手（変えた条件で数え直す）。候補が3件に満たないときだけ
    const short = candidates.length < MAX_CANDIDATES;
    const nearMisses: NearMiss[] = short
      ? nearMissesOf(attempt).map(({ match, miss }) => ({
          candidate: { ...toCandidate(match), travel: match.travel },
          miss,
        }))
      : [];
    const next = short
      ? suggestNextSteps(query, searchDeps, { shown: new Set(candidates.map((c) => c.festivalId)) })
      : { suggestions: [], attempts: 1 };
    session.nearMisses = nearMisses.map((n) => n.candidate);
    const search: SearchOutcome = {
      status: candidates.length > 0 ? "found" : "none",
      excluded: excludedCounts(attempt.misses),
      nearMisses,
      suggestions: next.suggestions,
      attempts: next.attempts,
    };

    const notes: string[] = [];
    if (ranges.wish === null) notes.push("希望の日はすでに過ぎています。別の日を聞いてください");
    const { excluded } = search;
    if (excluded.date + excluded.travel + excluded.area > 0) {
      notes.push(
        `条件から外れる祭りを候補から外しました（日程${excluded.date}件・片道の所要時間${excluded.travel}件・行き先${excluded.area}件）`,
      );
    }
    const unknown = shown.filter((p) => p.match.travel.fit === "unknown").length;
    const uncertain = shown.filter((p) => p.match.travel.fit === "uncertain").length;
    if (unknown > 0) {
      notes.push(
        `出発地からの所要時間が分からない祭りが${unknown}件あります。上限に収まるかは分からないと伝えてください`,
      );
    }
    if (uncertain > 0) {
      notes.push(
        `駅の位置からの見積もりでは、上限に収まるか境目の祭りが${uncertain}件あります。収まらないかもしれないと伝えてください`,
      );
    }
    const shownIds = new Set(picked.map((p) => p.match.festival.id));
    const withoutInfo = pool.filter((m, index) => {
      if (shownIds.has(m.festival.id)) return false;
      const result = pooledChecks[index]?.result;
      return result === "not_found" || result === "cancelled";
    }).length;
    if (withoutInfo > 0) {
      notes.push(
        `開催の情報が見つからなかった・中止と分かった祭りを${withoutInfo}件、候補から外しました`,
      );
    }
    if (picked.some((p) => p.check?.result === "needs_check")) {
      notes.push(
        "factCheck が needs_check の祭りは、公式以外の情報源や例年の日程で確かめたものです。「要事前確認」と伝え、出発の前に主催者の案内で確かめるよう添えてください",
      );
    }
    if (candidates.length === 0) {
      notes.push(
        "条件に合う祭りは見つかりませんでした。条件に合わない祭りを候補としてすすめず、「条件に合う祭りは見つかりませんでした」とそのまま伝えてください。" +
          "search.nearMisses の祭りは、外れている点（miss.detail）を必ず添えて「この祭りならやっています」と紹介し、" +
          "search.suggestions の次の手は画面のボタンにも出ています",
      );
    }
    const destination = attempt.destination;
    if (destination.kind === "ask") {
      notes.push(
        "destination.question をそのままお客さまに聞き、了承を得たら widen を広げて探し直してください",
      );
      return {
        today,
        searchedRange: ranges,
        candidates,
        details: [],
        destination: {
          prefectures,
          stage: null,
          needsConsent: destination.next,
          foundIn: destination.foundIn,
          question: destinationQuestion(label, destination),
        },
        search,
        notes,
      };
    }
    const stage = destination.kind === "matches" ? destination.stage : null;
    const foundIn = destination.kind === "matches" ? destination.foundIn : [];
    const reason = stage === null ? null : destinationReason(label, stage, foundIn);
    if (reason !== null && candidates.length > 0) {
      notes.push(`候補を出すときに「${reason}」と添えてください`);
    }

    return {
      today,
      searchedRange: ranges,
      candidates,
      ...(prefectures.length === 0
        ? {}
        : { destination: { prefectures, stage, needsConsent: null, foundIn, reason } }),
      details: shown.map(({ match: m, check }) => ({
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
        // data：祭りのデータの所要時間 / estimate：駅の位置からの見積もり（目安と伝える）
        travelBasis: m.travelBasis,
        travelFit: m.travel.fit,
        // 候補を出す前の確かめ。null は確かめていない（上限や、確かめる手段がない）
        factCheck: factCheckOf(check),
        arrivalBufferMinutes: arrivalBufferMinutes(m.festival),
        participation: m.festival.etiquette.participation,
      })),
      search,
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
  const food = foodEffects(ctx.session.conditions);
  const spots = festivals
    .flatMap((festival) =>
      selectNearbySpots(festival.nearby, {
        date,
        preferences: ctx.session.preferences,
        wantsShopMeals: food.wantsShopMeals,
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
    rules: [...preferenceEffects(ctx.session.preferences).rules, ...food.rules],
    notes,
  };
}

/**
 * 寄り道の Web の調べ（1回目と、広げた2回目を合わせて）を打ち切る時間（ミリ秒）。
 * 超えたら、それまでに調べた結果か、祭りのデータの周辺の場所に戻す。ツールの上限（95秒）より短くする
 */
export const NEARBY_RESEARCH_MS = 85_000;
/** 1回目の調べを打ち切る時間（ミリ秒）。2回目に回す時間を残す */
export const NEARBY_FIRST_ROUND_MS = 60_000;
/** 残りがこれより短ければ、広げた2回目の調べはしない（ミリ秒） */
export const NEARBY_WIDEN_MIN_MS = 25_000;

/** 車で回るか（想定している交通手段か、こだわりの移動） */
function travelsByCar(ctx: ToolContext): boolean {
  return transportEffects(ctx.session.conditions).usesCar || ctx.session.preferences.move === "car";
}

/** 調べ方を組むための、祭りのデータと相談の条件 */
function nearbySearchInput(
  ctx: ToolContext,
  festival: Festival,
  window: TimeWindow | undefined,
  focus?: string,
): NearbySearchInput {
  const { conditions } = ctx.session;
  const party = conditions.party;
  return {
    venueName: festival.venue.name,
    municipalities: festival.municipalities,
    stations: festival.access.stations.map((s) => s.name),
    foodWishes: conditions.foodWishes ?? [],
    dietary: conditions.dietary ?? [],
    withChildren: (party?.children ?? 0) + (party?.infants ?? 0) > 0,
    byCar: travelsByCar(ctx),
    ...(window === undefined ? {} : { window }),
    ...(focus === undefined ? {} : { focus: [focus] }),
  };
}

/** 店の報告に入れる、OpenStreetMap の店の数の上限（会場に近い順） */
const MAX_OSM_SPOTS = 12;

/** 会場の周りの店を、OpenStreetMap の一覧から近い順に引く。Web の調べに、確かめる店として渡す */
function findOsmSpots(
  ctx: ToolContext,
  festival: Festival,
  date: IsoDate,
  radiusKm: number,
): ResearchedSpotReport[] {
  if (ctx.osmPlaces === undefined) return [];
  const near = ctx.osmPlaces.find("food", festival.venue, radiusKm);
  // 会場の近くに店の少ない地域では、少し遠い店まで候補にする
  const places =
    near.length >= SPARSE_SHOP_COUNT
      ? near
      : ctx.osmPlaces.find("food", festival.venue, Math.max(radiusKm, SPARSE_SPOT_KM));
  // 食べたいものに合う店を先に拾う。Web の調べで当たらなくても、希望の料理の店を候補に残せる
  const wanted = shopFoodWishes(ctx.session.conditions.foodWishes ?? []);
  const reports = places.map((place) => osmSpotReport(place, date));
  return [
    ...reports.filter((report) => report.foods.some((food) => wanted.includes(food))),
    ...reports.filter((report) => !report.foods.some((food) => wanted.includes(food))),
  ].slice(0, MAX_OSM_SPOTS);
}

/** 会場の周りを Web で1回調べる。調べる手段がない・上限を超えた・失敗したときは null */
async function researchNearby(
  ctx: ToolContext,
  festival: Festival,
  date: IsoDate,
  search: NearbySearchInput,
  round: NearbySearchRound,
  timeoutMs: number,
  signal: AbortSignal,
  /** 公式のページを確かめてほしい店（OpenStreetMap で見つけた店など） */
  leads: readonly ResearchedSpotReport[] = [],
): Promise<ResearchedSpotReport[] | null> {
  if (ctx.nearby === undefined) return null;
  const { conditions } = ctx.session;
  try {
    const nearby = ctx.nearby;
    const shared = {
      festival: {
        id: festival.id,
        name: festival.name.ja,
        place: placeLabel(festival),
        venue: festival.venue,
      },
      date,
      foodWishes: conditions.foodWishes ?? [],
      dietary: conditions.dietary ?? [],
      perPersonBudgetYen:
        conditions.budget === undefined
          ? null
          : tripBudgetAmounts(conditions.budget, conditions.party).perPersonYen,
      party: conditions.party ?? null,
      references: [
        ...festival.nearby.map((s) => ({ name: s.name, kind: s.kind, summary: s.summary })),
        ...leads.map((s) => ({
          name: s.name,
          kind: s.kind,
          summary: s.summary,
          ...(s.website === undefined ? {} : { url: s.website }),
        })),
      ],
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      ...(ctx.progress ? { onActivity: ctx.progress } : {}),
    };
    // 1回目は観点ごとの調べ役を並べて動かす。1つが失敗しても、ほかの観点の結果は使う
    const plans =
      round === "first" ? nearbySearchPlans(search, leads) : [nearbySearchPlan(search, "widened")];
    // 混雑や通信の失敗は、1回だけやり直す
    const settled = await Promise.allSettled(
      plans.map((plan) =>
        retryOnce(() => nearby.research({ ...shared, plan }), { signal: shared.signal }),
      ),
    );
    const reports = settled.flatMap((result) =>
      result.status === "fulfilled" && result.value !== null ? [result.value.spots] : [],
    );
    return reports.length === 0 ? null : mergeResearchedReports(...reports);
  } catch {
    return null;
  }
}

function researchedSpotOutput(s: ResearchedSpot) {
  return {
    ...spotOutput(s),
    origin: "web" as const,
    // 出典のサイトの数。同じ条件なら、裏の取れた店を先に選ぶ
    sourceSites: s.sourceSites,
    // confirmed：行く日の営業を確かめた / needs_check：確かめられなかった（行く前に要確認）
    openStatus: s.openStatus,
    matchedFoods: s.matchedFoods,
  };
}

/** 昼・夜それぞれに入れられる店の候補。旅程係はここから食事の予定を選ぶ */
function mealOptions(spots: readonly NearbySpot[], date: IsoDate) {
  const list = (slot: MealSlot) =>
    mealCandidates(spots, date, slot).map((spot) => ({ spotId: spot.id, name: spot.name }));
  return { lunch: list("lunch"), dinner: list("dinner") };
}

/** 名前を比べる形にする（空白を除く） */
const sameName = (name: string) => name.replace(/\s+/g, "");

export const searchNearby = defineTool({
  name: "search_nearby",
  description:
    "祭りの前後に寄れる観光・食・休憩の場所を探す。周辺係が会場の周りを Web で調べ（祭りのデータの周辺の場所は参考にする）、" +
    "OpenStreetMap の店（出典が OpenStreetMap。営業は確かめていないので openStatus: needs_check）も合わせて、" +
    "食べたいもの・食事で気をつけたいこと・予算・同行者に合い、行く日に休みでない場所を返す（origin: web）。" +
    "行く日の営業を確かめられなかった場所は openStatus: needs_check になる。調べられなかったときは、祭りのデータの周辺の場所から選ぶ（research.status: fallback）。" +
    "当日が休業の場所、使える時間帯に営業時間が合わない場所は除き、こだわりに合う順に返す。「屋台で十分」のときの店は、屋台で昼を済ませられる祭りの日だけ除く。" +
    "食べたいものに合う店が1回目の調べで見つからなければ、場所と言葉を広げてもう1回調べる（research.rounds: 2）。" +
    "それでも見つからなければ research.foodFound が false になる。そのときも、昼・夜の食事に入れられる近くの店は返す（matchedFoods が空）。" +
    "mealCandidates に昼・夜それぞれの店の候補を返す。車で回るときは、会場から遠い店も返す。" +
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
    focus: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe("調べ直しで特に確かめること（評価の redo の ask）"),
  },
  async run(args, ctx, signal) {
    if (args.preferences !== undefined) ctx.session.preferences = args.preferences;
    if (args.festivalId === undefined) {
      if (args.area === undefined)
        throw new ToolError("festivalId か area のどちらかを渡してください");
      if (args.date === undefined) throw new ToolError("area で探すときは date を渡してください");
      return searchArea(ctx, args.area, args.date, args.window);
    }
    const festival = festivalOf(ctx, args.festivalId);
    const date = visitDate(ctx, festival, args.date);
    // 祭りを固定しているときは、ほかの祭りの周りを探しても、選んだ祭りを変えない
    if (ctx.session.anchor === null) ctx.session.selectedFestivalId = festival.id;
    // 周辺を調べ始めたら、旅程に要る経路と宿も並べて調べ始める（調べ直しのときは始めない）
    if (args.focus === undefined) startTripPrefetch(ctx, festival, date);
    const food = foodEffects(ctx.session.conditions);
    // 屋台で昼を済ませられない日（夜の祭りなど）は、こだわりが「屋台で十分」でも昼の店を探す
    const wantsShopMeals =
      food.wantsShopMeals || !stallsServeLunch(festival, occurrenceOn(festival, date));
    const selection = selectNearbySpots(festival.nearby, {
      date,
      preferences: ctx.session.preferences,
      wantsShopMeals,
      ...(args.window === undefined ? {} : { window: args.window }),
    });
    const base = {
      festivalId: festival.id,
      date,
      localFood: festival.food.local.map((f) => ({ name: f.name, note: f.note ?? null })),
      stalls: festival.food.stalls,
      rules: [...preferenceEffects(ctx.session.preferences).rules, ...food.rules],
    };
    const search = nearbySearchInput(ctx, festival, args.window, args.focus);
    const started = Date.now();
    // 営業まで確かめる Web の調べに、OpenStreetMap の店を、確かめる店として渡す
    const osmSpots = findOsmSpots(ctx, festival, date, searchRadiusKm(search.byCar, "first"));
    // この発言で調べてあれば、調べ直さず、時間帯とこだわりで選び直す（調べ直しを頼まれたときは調べる）
    const memoKey = `${festival.id}:${date}`;
    const memo = args.focus === undefined ? ctx.turn.nearbyReports.get(memoKey) : undefined;
    const webFirst =
      memo?.reports ??
      (await researchNearby(
        ctx,
        festival,
        date,
        search,
        "first",
        NEARBY_FIRST_ROUND_MS,
        signal,
        osmSpots,
      ));
    if (signal.aborted) throw new ToolError("止められたので、寄り道の結果は使いません");
    // Web で調べた店を先に置く（同じ店なら、営業を確かめた Web の報告を残す）
    const first = webFirst === null && osmSpots.length === 0 ? null : (webFirst ?? []);
    if (first === null) {
      return {
        ...base,
        research: {
          status: ctx.nearby === undefined ? "data_only" : "fallback",
          foodFound: null,
          rounds: ctx.nearby === undefined ? 0 : 1,
        },
        spots: selection.spots.map((spot) => ({ ...spotOutput(spot), origin: "data" as const })),
        mealCandidates: mealOptions(selection.spots, date),
        excluded: selection.excluded,
        notes:
          ctx.nearby === undefined
            ? []
            : ["会場の周りを Web で調べられなかったので、祭りのデータの周辺の場所から選びました"],
      };
    }

    const { conditions } = ctx.session;
    // 店の少ない地域では、距離の上限を広げる（昼の店を入れられるように）
    const sparse =
      osmSpots.filter((spot) => distanceKm(festival.venue, spot.location) <= WALK_SPOT_KM).length <
      SPARSE_SHOP_COUNT;
    const maxKm = Math.max(
      maxSpotKm(search.byCar),
      ctx.osmPlaces !== undefined && sparse ? SPARSE_SPOT_KM : 0,
    );
    const screen = (reports: readonly ResearchedSpotReport[]) =>
      screenResearchedSpots(reports, {
        date,
        ...(args.window === undefined ? {} : { window: args.window }),
        venue: festival.venue,
        maxKm,
        today: ctx.today(),
        preferences: ctx.session.preferences,
        wantsShopMeals,
        foodWishes: conditions.foodWishes ?? [],
        dietary: conditions.dietary ?? [],
        perPersonBudgetYen:
          conditions.budget === undefined
            ? null
            : tripBudgetAmounts(conditions.budget, conditions.party).perPersonYen,
        party: conditions.party ?? null,
      });
    let screened = screen(mergeResearchedReports(first, osmSpots));
    let rounds = memo?.rounds ?? 1;
    let reports = first;
    // 食べたいものに合う店か、食事に入れられる店が1つもなければ、時間の残りがあるときだけ、場所と言葉を広げてもう1回調べる
    const remaining = NEARBY_RESEARCH_MS - (Date.now() - started);
    const noShop = wantsShopMeals && !screened.spots.some((spot) => spot.kind === "food");
    if (
      memo === undefined &&
      (screened.foodFound === false || noShop) &&
      remaining >= NEARBY_WIDEN_MIN_MS
    ) {
      const widened = await researchNearby(
        ctx,
        festival,
        date,
        search,
        "widened",
        remaining,
        signal,
        osmSpots,
      );
      if (signal.aborted) throw new ToolError("止められたので、寄り道の結果は使いません");
      rounds = 2;
      if (widened !== null) {
        reports = mergeResearchedReports(first, widened);
        screened = screen(mergeResearchedReports(first, widened, osmSpots));
      }
    }
    if (webFirst !== null && args.focus === undefined) {
      ctx.turn.nearbyReports.set(memoKey, { reports, rounds });
    }
    // 旅程を保存するとき、祭りのデータの場所と同じく照らせるよう、調べた場所を相談に残す
    for (const spot of screened.spots) ctx.session.researchedSpots.set(spot.id, asNearbySpot(spot));
    // 見つけた場所は、旅程を保存するときに採否と理由がそろっているかを確かめる（調べ直しの分も足す）
    const found = new Map(
      (ctx.session.foundSpots.get(festival.id) ?? []).map((spot) => [spot.id, spot]),
    );
    // 地図のデータだけで営業を確かめていない店は候補の一覧なので、採らなかった理由までは求めない
    for (const spot of screened.spots) {
      if (spot.sources.some((source) => source.title !== OSM_ATTRIBUTION)) {
        found.set(spot.id, { id: spot.id, name: spot.name });
      }
    }
    ctx.session.foundSpots.set(festival.id, [...found.values()]);
    // 祭りのデータの店は、出す料理が分からないので、食べたいものに合う店が調べて見つかったときは調べた店だけにする
    const researchedNames = new Set(screened.spots.map((spot) => sameName(spot.name)));
    const dataSpots = selection.spots.filter(
      (spot) =>
        !(screened.foodFound === true && spot.kind === "food") &&
        !researchedNames.has(sameName(spot.name)),
    );
    const notes: string[] = [];
    if (screened.foodFound === false) {
      notes.push(
        "食べたいものに合う店は、調べても見つかりませんでした。昼・夜の食事は mealCandidates の近くの店で案を作り、希望の料理の店は見つからなかったと報告してください（合う料理を出すとは書かない）",
      );
    }
    if (screened.spots.some((spot) => spot.openStatus === "needs_check")) {
      notes.push(
        "openStatus が needs_check の場所は、行く日の営業を確かめられませんでした。予定に入れるなら、reason に「営業は行く前に要確認」と書いてください",
      );
    }
    return {
      ...base,
      research: { status: "researched", foodFound: screened.foodFound, rounds },
      spots: [
        ...screened.spots.map(researchedSpotOutput),
        ...dataSpots.map((spot) => ({ ...spotOutput(spot), origin: "data" as const })),
      ],
      mealCandidates: mealOptions([...screened.spots, ...dataSpots], date),
      excluded: [...selection.excluded, ...screened.excluded],
      notes,
    };
  },
});

export const getAccess = defineTool({
  name: "get_access",
  description:
    "出発地から祭りの会場への行き方の目安を、保存してある公式のアクセス案内から返す。" +
    "最寄り駅と徒歩、主要駅からの所要時間、駐車場、交通規制。時間はすべて目安。" +
    "聞き取りで想定している交通手段を言われていれば、それに合わせた道のりの決まりを rules に入れる。",
  input: {
    festivalId: SlugSchema.describe("祭りの ID"),
    origin: z.string().trim().min(1).max(50).optional().describe("出発地。省略すると相談の出発地"),
    move: z.enum(MOVE_MODES).optional().describe("train 電車 / car 車。省略すると相談のこだわり"),
  },
  async run(args, ctx) {
    const festival = festivalOf(ctx, args.festivalId);
    const origin = args.origin ?? ctx.session.conditions.origin ?? null;
    const move = args.move ?? ctx.session.preferences.move;
    const transport = transportEffects(ctx.session.conditions);
    const { access } = festival;
    const hub = origin === null ? undefined : matchHub(access, origin);
    const estimate = origin === null ? null : travelEstimateFor(ctx, festival, origin);
    const notes: string[] = [];
    if (origin !== null) {
      notes.push(
        `旅程は出発の駅（${origin}）から始めてください。主要駅（fromHubs）は出発の駅ではありません`,
      );
    }
    if (hub === undefined && estimate !== null) {
      notes.push(
        "出発の駅からの所要時間はデータにないので、駅の位置から見積もりました（fromOrigin）。research_route で行き方を調べてから組んでください",
      );
    } else if (hub === undefined) {
      notes.push(
        "出発の駅からの所要時間は分かりません。research_route で行き方を調べてから組んでください",
      );
    }
    if (move === "car" || transport.usesCar) {
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
        hub !== undefined
          ? {
              origin,
              hub: hub.hub,
              route: hub.route ?? null,
              trainMinutesEstimate: hub.minutes,
              doorToVenueMinutesEstimate: origin ? travelMinutesFrom(access, origin) : null,
              basis: "data",
            }
          : estimate === null
            ? null
            : {
                origin,
                hub: estimate.viaHub,
                route: null,
                trainMinutesEstimate: null,
                doorToVenueMinutesEstimate: estimate.minutes,
                basis: estimate.basis,
                nearestStation: estimate.nearestStation,
              },
      fromHubs: access.fromHubs,
      parking: access.parking,
      trafficRestrictions: access.trafficRestrictions,
      arrivalBufferMinutes: arrivalBufferMinutes(festival),
      sources: access.sources,
      rules: transport.rules,
      notes,
    };
  },
});

/** 調べた行き方の出典を、旅程の出典の形にする。行き方の調べは1つの情報源として扱う */
function routeSources(
  ctx: ToolContext,
  sources: readonly { url: string; title?: string }[],
): Source[] {
  return sources.map((s) => ({
    url: s.url,
    ...(s.title ? { title: s.title } : {}),
    checkedAt: ctx.today(),
    confidence: "single" as const,
  }));
}

/** 行き方を1回調べる（行きか帰り）。research_route と research_trip から呼ぶ */
async function researchRouteOnce(
  ctx: ToolContext,
  festival: Festival,
  options: {
    origin?: string | undefined;
    date?: IsoDate | undefined;
    arriveBy?: string | undefined;
    direction: RouteDirection;
    focus?: string | undefined;
  },
  signal: AbortSignal,
) {
  const origin = options.origin ?? ctx.session.conditions.origin;
  if (origin === undefined)
    throw new ToolError("出発の駅が分かりません。先に出発の駅を聞いてください");
  const date = visitDate(ctx, festival, options.date);
  const station = destinationStation(ctx, festival);
  const returnTo = ctx.session.conditions.returnTo ?? origin;
  const isReturn = options.direction === "return";
  const from = isReturn ? station : origin;
  const to = isReturn ? returnTo : station;
  // 駅の位置からの見積もりは出発の駅から会場まで。帰りは、終わりの場所が出発の駅と同じときだけ照らす
  const estimate =
    !isReturn || returnTo === origin ? travelEstimateFor(ctx, festival, origin) : null;
  const walk = festival.access.stations[0]?.walkMinutes ?? null;
  const base = {
    festivalId: festival.id,
    direction: options.direction,
    origin: from,
    destinationStation: to,
    walkMinutesFromStationEstimate: walk,
    estimate: estimate === null ? null : { minutes: estimate.minutes, basis: estimate.basis },
    rules: isReturn
      ? [
          `帰りの移動（type: "move"、move.purpose: "return"）の move.from は会場、move.to は ${returnTo} にする`,
          "researched.legs があれば、会場から駅まで歩く区間を先頭に足して move.legs にし、researched.sources を出典にする",
          "researched.lastDeparture があれば、その日の lastReturn に station と departBy と researched.sources を書く。null なら departBy を null にする（推測で書かない）",
        ]
      : [
          `旅程の最初の予定は、出発の駅（${origin}）からの移動（type: "move"、move.purpose: "outbound"）にし、name に出発の駅の名前を入れる`,
          "move.minutes には、researched があればその minutes、なければ estimate の minutes をそのまま使い、estimate: true にする",
          "researched.legs があれば move.legs にそのまま写し（乗り換えの駅は区間の境）、researched.sources を予定の出典にする",
        ],
  };
  const sameStation =
    station !== null && normalizeStationName(station) === normalizeStationName(origin);
  if (ctx.routes === undefined || from === null || to === null || sameStation) {
    return { ...base, status: "estimate_only" as const, researched: null };
  }
  const routes = ctx.routes;
  let report: Awaited<ReturnType<NonNullable<ToolContext["routes"]>["research"]>> = null;
  try {
    // 混雑や通信の失敗は、1回だけやり直す
    report = await retryOnce(
      () =>
        routes.research({
          from,
          to,
          date,
          direction: options.direction,
          ...(options.arriveBy ? { arriveBy: options.arriveBy } : {}),
          ...(options.focus ? { focus: options.focus } : {}),
          ...(ctx.progress ? { onActivity: ctx.progress } : {}),
          signal,
        }),
      { signal },
    );
  } catch {
    report = null;
  }
  if (signal.aborted) throw new ToolError("止められたので、行き方の結果は使いません");
  if (report === null) return { ...base, status: "not_found" as const, researched: null };
  const checked = checkResearchedMinutes(report.minutes, estimate, walk);
  if (!checked.ok) {
    return { ...base, status: "rejected" as const, reason: checked.reason, researched: null };
  }
  const sources = routeSources(ctx, report.sources);
  // 旅程を保存するとき、移動と帰りの最終の出典として認めるよう、読んだページを相談に残す
  for (const source of sources) ctx.session.researchedSources.set(source.url, source);
  return {
    ...base,
    status: "researched" as const,
    researched: {
      minutes: checked.minutes,
      summary: report.summary,
      transfers: report.transfers,
      legs: report.legs ?? null,
      ...(isReturn ? { lastDeparture: report.lastDeparture ?? null } : {}),
      sources,
    },
  };
}

export const researchRoute = defineTool({
  name: "research_route",
  description:
    "出発の駅から祭りの会場の最寄り駅までの電車の行き方（乗る路線・乗り換えごとの区間・所要時間の幅）を、公開の情報で調べる。" +
    "direction: return では、会場の最寄り駅から終わりの駅までの帰りの行き方と、その日のうちに帰れる最終の時刻（lastDeparture）を調べる。" +
    "調べた所要時間は、駅の位置からの見積もりと照らし、食い違うものは使わない（その場合は見積もりを返す）。" +
    "旅程の行き・帰りの移動の move（minutes・from・to・legs）と出典、帰りの最終（lastReturn）に使う。同じ祭りで同じ向きを呼び直さない（調べ直しは focus を付ける）。",
  input: {
    festivalId: SlugSchema.describe("祭りの ID"),
    origin: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .describe("出発の駅。省略すると相談の出発地"),
    date: IsoDateSchema.optional().describe("行く日。省略すると候補や旅程の日"),
    arriveBy: LocalTimeSchema.optional().describe(
      "この時刻までに会場の最寄り駅に着きたい（HH:MM）",
    ),
    direction: z
      .enum(["outbound", "return"])
      .optional()
      .describe("outbound 行き（省略時）/ return 帰り（最終の時刻も調べる）"),
    focus: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe("調べ直しで特に確かめること（評価の redo の ask）"),
  },
  async run(args, ctx, signal) {
    const festival = festivalOf(ctx, args.festivalId);
    const direction = args.direction ?? "outbound";
    // 先に始めた同じ調べがあれば、2回動かさず、その結果を待つ
    const current = ctx.turn.prefetch;
    if (
      current !== null &&
      args.focus === undefined &&
      args.arriveBy === undefined &&
      (args.origin === undefined || args.origin === ctx.session.conditions.origin) &&
      current.key === `${festival.id}:${visitDate(ctx, festival, args.date)}`
    ) {
      const result = await (direction === "return" ? current.inbound : current.outbound);
      if (result.ok) return result.value as Awaited<ReturnType<typeof researchRouteOnce>>;
    }
    return researchRouteOnce(
      ctx,
      festival,
      {
        origin: args.origin,
        date: args.date,
        arriveBy: args.arriveBy,
        direction,
        focus: args.focus,
      },
      signal,
    );
  },
});

/** research_trip で、食事の時間帯から寄り道の調べの時間帯を決める（昼と夜の両方なら決めない） */
function mealWindow(meals: readonly MealSlot[] | undefined): TimeWindow | undefined {
  const [only] = meals ?? [];
  if (meals === undefined || meals.length !== 1 || only === undefined) return undefined;
  const [start, end] = MEAL_WINDOWS[only];
  // 食事の時間帯の前後30分も含めて探す
  return { from: fromMinutes(toMinutes(start) - 30), to: fromMinutes(toMinutes(end) + 30) };
}

/** 並べた調べの1つ。失敗しても、ほかの調べの結果は使う */
async function settle<T>(task: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "調べられませんでした" };
  }
}

export const researchTrip = defineTool({
  name: "research_trip",
  description:
    "旅程を組む前（と、評価で調べ直しを頼まれたとき）に、経路と食事・寄り道の調べを並べて動かす。" +
    "route：行き（出発の駅→会場の最寄り駅、乗り換えごとの区間）と帰り（会場の最寄り駅→終わりの駅、乗り換えと最終の時刻）。" +
    "nearby：会場の周りの食事の店・寄り道の場所（search_nearby と同じ調べ。meals で昼・夜に絞れる）。" +
    "lodging は search_lodging で調べる（ここでは調べない）。係の失敗は分類して1回だけ自動でやり直し、失敗した調べは failed に名前を返す。" +
    "評価の redo を受けたら、only に係を、focus に ask を渡して呼ぶ。",
  input: {
    festivalId: SlugSchema.describe("祭りの ID"),
    date: IsoDateSchema.optional().describe("行く日。省略すると候補や旅程の日"),
    only: z
      .array(z.enum(RESEARCH_TARGETS))
      .min(1)
      .max(RESEARCH_TARGETS.length)
      .optional()
      .describe("調べる係（省略すると route と nearby の両方）"),
    focus: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe("調べ直しで特に確かめること（評価の redo の ask）"),
    meals: z
      .array(z.enum(MEAL_SLOTS))
      .min(1)
      .max(MEAL_SLOTS.length)
      .optional()
      .describe("食事の店を探す時間帯（省略すると昼と夜の両方）"),
    arriveBy: LocalTimeSchema.optional().describe(
      "この時刻までに会場の最寄り駅に着きたい（HH:MM）",
    ),
  },
  async run(args, ctx, signal) {
    const festival = festivalOf(ctx, args.festivalId);
    const only = new Set(args.only ?? ["route", "nearby"]);
    const routeOptions = (direction: RouteDirection) => ({
      date: args.date,
      arriveBy: direction === "outbound" ? args.arriveBy : undefined,
      direction,
      focus: args.focus,
    });
    const window = mealWindow(args.meals);
    // 評価の頼み（focus つき）で調べ直すときは、頼まれた係が受けるようすを見せる
    if (args.focus !== undefined) {
      if (only.has("nearby")) {
        for (const slot of args.meals ?? ["sightseeing" as const]) {
          ctx.emit?.(redoAcceptEvent("nearby", slot));
        }
      }
      if (only.has("route")) ctx.emit?.(redoAcceptEvent("route", "route"));
    }
    // 同じ祭りと日の経路は、先に始めた調べの結果を使う（同じ調べを2回動かさない）
    const prefetched =
      args.focus === undefined && args.arriveBy === undefined
        ? startTripPrefetch(ctx, festival, visitDate(ctx, festival, args.date))
        : null;
    const [outbound, inbound, nearby] = await Promise.all([
      only.has("route")
        ? (prefetched?.outbound ??
          settle(() => researchRouteOnce(ctx, festival, routeOptions("outbound"), signal)))
        : null,
      only.has("route")
        ? (prefetched?.inbound ??
          settle(() => researchRouteOnce(ctx, festival, routeOptions("return"), signal)))
        : null,
      only.has("nearby")
        ? settle(() =>
            searchNearby.run(
              {
                festivalId: festival.id,
                ...(args.date ? { date: args.date } : {}),
                ...(window ? { window } : {}),
                ...(args.focus ? { focus: args.focus } : {}),
              },
              ctx,
              signal,
            ),
          )
        : null,
    ]);
    if (signal.aborted) throw new ToolError("止められたので、調べの結果は使いません");
    const failed = [
      ...(outbound?.ok === false ? ["route:outbound"] : []),
      ...(inbound?.ok === false ? ["route:return"] : []),
      ...(nearby?.ok === false ? ["nearby"] : []),
    ];
    const notes = [
      "経路と食事の結果から、行き・最後の移動・帰りの move（from・to・purpose・legs）と出典、帰りの最終（lastReturn）を書いてください",
      "滞在の時間帯にかかる昼・夜の食事は、時間を取って予定に入れてください（nearby.mealCandidates の店の type: meal の予定か、その時間帯の祭りの予定の中の屋台）。入っていない旅程は保存できません",
      "見つけた場所（nearby.spots の origin: web）は、使うか使わないかと理由を considered に書いてください",
      ...(only.has("lodging")
        ? ["宿の調べ直しは search_lodging で行ってください（同じ条件で呼び直さない）"]
        : []),
      ...(failed.length > 0
        ? [
            `調べられなかったもの（${failed.join("、")}）は推測で埋めず、旅程の gaps に残ります。お客さまには分からなかったと伝えてください`,
          ]
        : []),
    ];
    return {
      festivalId: festival.id,
      route:
        outbound === null
          ? null
          : {
              outbound: outbound.ok ? outbound.value : null,
              return: inbound?.ok ? inbound.value : null,
            },
      nearby: nearby === null ? null : nearby.ok ? nearby.value : null,
      failed,
      notes,
    };
  },
});

/** 先に始める調べを打ち切る時間（ミリ秒）。行き方の調べ（調べ直しを含む）より長く、ツールの上限より短くする */
const PREFETCH_MS = 95_000;
/** 旅程係を動かす前に、先に始めた調べを待つ時間（ミリ秒） */
export const PREFETCH_WAIT_MS = 60_000;

/**
 * 旅程に要る調べ（行き・帰りの経路と、泊まりなら祭りの夜の宿）を、先に並べて始める。同じ祭りと日なら1回だけ。
 * すでに旅程があるとき（修正）や、調べる手段や出発の駅がないときは始めない
 */
export function startTripPrefetch(
  ctx: ToolContext,
  festival: Festival,
  date: IsoDate,
): TripPrefetch | null {
  const key = `${festival.id}:${date}`;
  const current = ctx.turn.prefetch;
  if (current !== null) return current.key === key ? current : null;
  if (ctx.routes === undefined || ctx.session.itineraryId !== null) return null;
  if (ctx.session.conditions.origin === undefined) return null;
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(PREFETCH_MS)]);
  const route = (direction: RouteDirection) =>
    settle<unknown>(() => researchRouteOnce(ctx, festival, { date, direction }, signal));
  const prefetch: TripPrefetch = {
    key,
    outbound: route("outbound"),
    inbound: route("return"),
    lodging:
      (ctx.session.conditions.nights ?? 0) > 0 && ctx.session.conditions.stayNear !== "town"
        ? settle<unknown>(() =>
            searchLodging.run({ festivalId: festival.id, checkIn: date, nights: 1 }, ctx, signal),
          )
        : null,
  };
  ctx.turn.prefetch = prefetch;
  return prefetch;
}

/** 旅程係に渡す、先に調べた結果の文。調べを始めていなければ空。待ち切れなかった調べは名前だけを伝える */
export async function prefetchBriefing(
  ctx: ToolContext,
  waitMs: number = PREFETCH_WAIT_MS,
): Promise<string> {
  const { session } = ctx;
  const festivalId = session.anchor?.festivalId ?? session.selectedFestivalId;
  const festival = festivalId === null ? undefined : ctx.festivals.get(festivalId);
  if (festival !== undefined) {
    try {
      startTripPrefetch(ctx, festival, session.anchor?.date ?? visitDate(ctx, festival, undefined));
    } catch {
      // 行く日が決まらなければ、旅程係が調べる
    }
  }
  const prefetch = ctx.turn.prefetch;
  if (prefetch === null) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  const finished = async (task: Promise<Settled<unknown>> | null) =>
    task === null ? null : Promise.race([task, timedOut]);
  const [outbound, inbound, lodging] = await Promise.all([
    finished(prefetch.outbound),
    finished(prefetch.inbound),
    finished(prefetch.lodging),
  ]);
  clearTimeout(timer);
  const section = (label: string, result: Settled<unknown> | null, then: string) => {
    if (result === null) return `${label}：まだ調べています。${then}`;
    return result.ok
      ? `${label}：\n${JSON.stringify(result.value)}`
      : `${label}：調べられませんでした。推測で埋めず、${then}`;
  };
  return [
    "先にサーバーが調べた結果です。同じ調べを呼び直さず、これを使って組みます。",
    section("行きの経路", outbound, "research_trip（only: route）で確かめてください"),
    section("帰りの経路", inbound, "research_trip（only: route）で確かめてください"),
    ...(prefetch.lodging === null
      ? []
      : [
          section(
            "祭りの夜の宿（調べた候補は保存のときにサーバーが付ける）",
            lodging,
            "必要なら search_lodging を呼んでください",
          ),
        ]),
  ].join("\n");
}

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
    "2泊までの旅はすべての日を1回で保存する。3泊からの旅は1日ずつ書く：はじめに主役の祭りの日だけの旅程を itinerary で保存し、そのあと addDay で1日ずつ足す（同じ日付なら置き換える）。" +
    "後ろに足すときは、それまでの最後の日の夜に泊まる地域を stayBefore に書く。保存のたびに画面の旅程が更新される。" +
    "stay に宿の名前は書かない。search_lodging で調べた宿の候補は、チェックインの日の stay にサーバーが付ける。" +
    "移動には from・to・purpose（outbound・last_mile・between・return）と、電車・バスなら legs（乗り換えごとの区間）と出典を書く。" +
    "滞在の時間帯にかかる昼（11:30〜13:30）・夜（17:30〜19:30）の食事は、その時間帯に30分以上の type: meal の予定を入れるか、その時間帯の予定の中でとる案（meals の itemId にその予定の id）を書く。" +
    "食事が足りない旅程は保存せず errors を返す。その日のうちに帰る日は帰りの最終（lastReturn）を書く。" +
    "周辺係・宿の係が見つけた場所は、採否の理由を considered に書く（採ったかはサーバーが決める）。" +
    "保存すると、そろっていないもの（gaps）と評価（evaluation：網羅・具体さ・無理のなさ・出典の点）を返す。" +
    "基準に届かなければ next に従って research_trip で調べ直し、作り直して呼び直す（評価は1回の発言で3回まで）。",
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
      const { gaps: _gaps, evaluation: _evaluation, ...draft } = args.itinerary;
      written = draft as ItineraryDraft;
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
    const prepared = await prepareItinerary(ctx, written, previous);
    if (!prepared.ok) {
      return { saved: false, errors: prepared.errors, warnings: prepared.warnings };
    }
    const { result, warnings } = prepared;
    // 時間切れや接続の切断のあとに、旅程を書き換えない
    if (signal.aborted) throw new ToolError("止められたので、旅程は保存しません");
    // 保存する旅程を評価する（評価して作り直すループの1回）。前と同じ旅程なら、評価し直さない
    const evaluation =
      result.unchanged && result.itinerary.evaluation !== undefined
        ? result.itinerary.evaluation
        : await reviewPlan({
            ctx,
            itinerary: result.itinerary,
            gaps: result.gaps,
            warnings,
            conditions: shopRecordForReview(ctx),
            signal,
          });
    if (signal.aborted) throw new ToolError("止められたので、旅程は保存しません");
    const itinerary: Itinerary = { ...result.itinerary, evaluation };
    // 基準に届かなければ、店内のスタッフどうしで調べ直しを頼むようすを見せる
    if (!result.unchanged) {
      for (const event of redoRequestEvents(evaluation, result.gaps)) ctx.emit?.(event);
    }
    if (!result.unchanged) {
      if (!ctx.itineraries.saveForSession(session, itinerary)) {
        throw new ToolError("旅が消されたので、旅程は保存しません");
      }
      session.itineraryId = itinerary.id;
      session.selectedFestivalId = itinerary.mainFestivalId;
    }
    ctx.turn.savedItinerary = true;
    return {
      saved: !result.unchanged,
      unchanged: result.unchanged,
      itineraryId: itinerary.id,
      version: itinerary.version,
      diff: result.diff,
      errors: [],
      warnings,
      gaps: result.gaps,
      evaluation,
      next: result.unchanged
        ? `前の版と同じ旅程です。${nextStepAfter(evaluation, canRedoPlan(ctx.turn.startedAt))}`
        : nextStepAfter(evaluation, canRedoPlan(ctx.turn.startedAt)),
      itinerary,
    };
  },
});

export type PreparedItinerary =
  | {
      ok: true;
      result: Extract<ReturnType<typeof buildItinerary>, { ok: true }>;
      warnings: Issue[];
    }
  | { ok: false; errors: readonly Issue[]; warnings: readonly Issue[] };

type Issue = { code: string; itemId?: string | null; message: string };

/**
 * 旅程の下書きを、保存できる旅程にする（保存はしない）。祭りの固定・出発の駅・片道の上限・天気・出典・点検を通す。
 * findFestival を渡すと、祭りのデータの代わりに使う（通知で分かった変更を入れて照らすとき）
 */
export async function prepareItinerary(
  ctx: ToolContext,
  written: ItineraryDraft,
  previous: Itinerary | null,
  options: {
    findFestival?: (id: string) => Festival | undefined;
    /** 調べた場所の採否を決め直す（祭りのデータで照らしたあとの下書きと、見つけた場所を受け取る） */
    reviewResearched?: (
      draft: ItineraryDraft,
      found: ResearchedPlace[],
    ) => { draft: ItineraryDraft; researched: ResearchedPlace[] };
  } = {},
): Promise<PreparedItinerary> {
  const { session } = ctx;
  // 祭りを固定しているときは、主役の祭り・祭りの日・旅の日付を先に確かめる
  const anchorChecks = checkAnchorOnSave(ctx, written);
  if (anchorChecks.errors.length > 0) {
    console.info(
      JSON.stringify({
        kind: "itinerary_rejected",
        codes: anchorChecks.errors.map((e) => e.code),
      }),
    );
    return { ok: false, errors: anchorChecks.errors, warnings: [] };
  }
  // こだわりと予算と出発の駅は相談の状態を正とする。泊まりの宿の候補は、調べた結果だけをサーバーが付ける
  const origin = session.conditions.origin;
  const draft: ItineraryDraft = attachLodging(
    { ...written, preferences: session.preferences, ...(origin ? { origin } : {}) },
    { searches: session.lodging, previous },
  );
  // 旅程は出発の駅から始める。始まりの移動の時間が、出発の駅からの目安より明らかに短いものは保存しない
  if (origin !== undefined) {
    // 移動の時間を比べるのは、1日目に主役の祭りへ向かうときだけ（何日かの旅の1日目は別の場所へ向かうことがある）
    const firstDay = draft.days[0]?.items ?? [];
    const main = firstDay.some((item) => item.festivalId === draft.mainFestivalId)
      ? ctx.festivals.get(draft.mainFestivalId)
      : undefined;
    const startIssues = checkStartsAtOrigin(
      firstDay,
      origin,
      main === undefined ? null : travelEstimateFor(ctx, main, origin),
    );
    // 日帰りの片道の上限は必ず守る条件なので、候補の絞り込みだけでなく、保存する旅程でも確かめる
    const { nights, maxTravelMinutes } = session.conditions;
    if (startIssues.length === 0 && nights === 0 && maxTravelMinutes !== undefined) {
      startIssues.push(...checkDayTripLimit(firstDay, maxTravelMinutes));
    }
    if (startIssues.length > 0) {
      console.info(
        JSON.stringify({ kind: "itinerary_rejected", codes: startIssues.map((e) => e.code) }),
      );
      return { ok: false, errors: startIssues, warnings: [] };
    }
  }
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

  const found = researchedPlaces(ctx, draft);
  const reviewed = options.reviewResearched?.(draft, found) ?? { draft, researched: found };
  const result = buildItinerary(reviewed.draft, {
    id: previous?.id ?? randomId("trip"),
    previous,
    budget: session.conditions.budget,
    weatherFor: (date) => weatherByDate.get(date) ?? { status: "unavailable" },
    findFestival: options.findFestival ?? ((id) => ctx.festivals.get(id)),
    // 周辺係が調べた場所も照らす。前の版に入っている調べた場所は、相談を戻したあとでも直せるよう前の版から引く
    extraSpots: new Map([
      ...(previous === null ? [] : researchedSpotsInItinerary(previous)),
      ...session.researchedSpots,
    ]),
    // 行き方の調べで読んだページも出典として認める。前の版の移動・食事の案の出典も引き継ぐ
    extraSources: new Map([
      ...(previous === null ? [] : plannedSourcesInItinerary(previous)),
      ...session.researchedSources,
    ]),
    researched: reviewed.researched,
  });
  if (!result.ok) {
    // 旅程係の組み方の傾向をつかむため、断った理由の種類だけを残す（予定の名前や文は残さない）
    console.info(
      JSON.stringify({ kind: "itinerary_rejected", codes: result.errors.map((e) => e.code) }),
    );
    return { ok: false, errors: result.errors, warnings: result.warnings };
  }
  return { ok: true, result, warnings: [...result.warnings, ...anchorChecks.warnings] };
}

/** 祭りを固定した旅程の決まりを確かめる。中止と分かった祭りの旅程は、固定を外したあとでも保存しない */
function checkAnchorOnSave(
  ctx: ToolContext,
  draft: ItineraryDraft,
): {
  errors: (AnchorIssue | { code: "anchor_cancelled"; itemId: null; message: string })[];
  warnings: AnchorIssue[];
} {
  const { anchor, anchorPlan, cancelledAnchor: cancelled } = ctx.session;
  if (
    cancelled !== null &&
    draft.mainFestivalId === cancelled.festivalId &&
    draft.days.some(
      (day) =>
        day.date === cancelled.date &&
        day.items.some((i) => i.type === "festival" && i.festivalId === cancelled.festivalId),
    )
  ) {
    return {
      errors: [
        {
          code: "anchor_cancelled",
          itemId: null,
          message: `${cancelled.name}の${cancelled.date}の開催は中止と分かりました。この旅程は保存しません。お客さまに伝えて、ほかの祭りを選んでもらってください`,
        },
      ],
      warnings: [],
    };
  }
  if (anchor === null) return { errors: [], warnings: [] };
  return checkAnchoredItinerary(
    draft,
    anchor,
    anchorPlan,
    (id) => ctx.festivals.get(id)?.municipalities.map((m) => m.prefecture) ?? [],
  );
}

/**
 * 前の版の移動・帰りの最終・食事の案の出典（相談を戻したあとでも、同じ出典で直せるように）。
 * 調べた店を指す食事の案は、予定にならない店だと場所の一覧から引けないので、ここで出典を認める
 */
function plannedSourcesInItinerary(itinerary: Itinerary): Map<string, Source> {
  const sources = new Map<string, Source>();
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.type !== "move") continue;
      for (const source of item.sources) sources.set(source.url, source);
    }
    for (const source of day.lastReturn?.sources ?? []) sources.set(source.url, source);
    for (const meal of day.meals ?? []) {
      for (const source of meal.sources) sources.set(source.url, source);
    }
  }
  return sources;
}

/** 周辺係が見つけた場所（主役の祭りの周り）と、泊まりに付けた宿の候補。採否と理由がそろっているかを確かめる */
function researchedPlaces(ctx: ToolContext, draft: ItineraryDraft): ResearchedPlace[] {
  const spots = (ctx.session.foundSpots.get(draft.mainFestivalId) ?? []).map(
    (spot): ResearchedPlace => ({ ...spot, from: "nearby" }),
  );
  const offers = draft.days.flatMap((day) =>
    (day.stay?.lodging?.offers ?? []).map(
      (offer): ResearchedPlace => ({ id: offer.id, name: offer.name, from: "lodging" }),
    ),
  );
  return [...spots, ...offers];
}

/** 評価係に渡す、聞き取った条件の要約（会話の文は渡さない） */
export function shopRecordForReview(ctx: ToolContext): string {
  const { conditions, preferences } = ctx.session;
  return JSON.stringify({
    origin: conditions.origin ?? null,
    returnTo: conditions.returnTo ?? null,
    nights: conditions.nights ?? null,
    party: conditions.party ?? null,
    foodWishes: conditions.foodWishes ?? [],
    dietary: conditions.dietary ?? [],
    pace: conditions.pace ?? null,
    interests: conditions.interests ?? [],
    preferences,
  });
}

type KnownVerification = Exclude<Itinerary["verification"], { status: "pending" }>;

/**
 * 決定のときに使える、確かめ済みの開催の結果。旅程にすでにあればそれ、なければ候補を出す前の確かめの結果。
 * どちらもなければ null（そのときだけ Web で確かめる）
 */
function knownVerification(
  ctx: ToolContext,
  itinerary: Itinerary,
  festivalId: string,
  date: IsoDate,
): KnownVerification | null {
  if (itinerary.verification.status !== "pending") return itinerary.verification;
  const check = ctx.candidateChecks?.peek?.(festivalId, date) ?? null;
  if (check === null) return null;
  const parsed = VerificationSchema.safeParse({
    status: check.result,
    checkedAt: check.checkedAt,
    sources: check.sources,
    ...(check.note ? { note: check.note } : {}),
  });
  return parsed.success && parsed.data.status !== "pending" ? parsed.data : null;
}

/** 宿の候補を出すときに必ず添える一文 */
export const LODGING_NOTICE = "料金と空きは、予約の時点で変わることがあります";
/** Web で調べた宿を出すときに必ず添える一文（空きは調べていない） */
export const RESEARCHED_LODGING_NOTICE =
  "空きは調べていません。料金と空きは、予約のページで確かめてください";

/**
 * Web の宿の調べを打ち切る時間。ツールの上限（95秒）より短くし、間に合った観点の結果だけで選ぶ
 * （ツールの上限で止まると、調べた結果をすべて捨ててしまうため）
 */
export const LODGING_RESEARCH_MS = 75_000;

/** 宿の空きの調べ（空室検索）の結果に、会場からの距離と移動の目安を足す */
function withFromVenue(search: LodgingSearch, venue: LatLng): LodgingSearch {
  return {
    ...search,
    offers: search.offers.map((offer) =>
      offer.location === null || offer.fromVenue !== undefined
        ? offer
        : { ...offer, fromVenue: lodgingFromVenue(venue, offer.location) },
    ),
  };
}

/**
 * 宿の候補を調べる。空室検索（楽天トラベル）で空きのある宿が見つかればそれを使い、
 * キーがない・調べられない・空きが見つからないときは、Web の宿の調べ（観点ごとに並べて調べ、コードで突き合わせる）に移る。
 * どちらもなければ、宿の空きの調べ方の結果（開発では架空の宿、本番では「調べられない」）を返す
 */
async function findLodging(
  ctx: ToolContext,
  festival: Festival,
  args: { checkIn: IsoDate; nights: number; radiusKm?: number | undefined },
  party: Party,
  budget: LodgingBudget | undefined,
  signal: AbortSignal,
): Promise<LodgingOutcome> {
  const venue = { lat: festival.venue.lat, lng: festival.venue.lng };
  const query = {
    checkIn: args.checkIn,
    nights: args.nights,
    party,
    near: venue,
    radiusKm: args.radiusKm ?? MAX_SEARCH_RADIUS_KM,
  };
  let fallback: LodgingOutcome | null = null;
  /** OpenStreetMap の宿を候補にする。空きは調べていないので、Web で調べた宿と同じ注意を添える */
  const osmLodging = (): LodgingOutcome | null => {
    const places = ctx.osmPlaces?.find("lodging", venue, VENUE_LODGING_KM);
    const searchedAt = ctx.now();
    const offers = osmLodgingOffers(places ?? [], {
      venue,
      checkedAt: searchedAt,
      today: ctx.today(),
    });
    if (offers.length === 0) return null;
    return {
      status: "ok",
      search: {
        checkIn: args.checkIn,
        checkOut: addDays(args.checkIn, args.nights),
        searchedAt,
        provider: "web",
        offers,
      },
    };
  };
  if (ctx.lodging.provider === "rakuten") {
    fallback = await ctx.lodging.search(query, signal);
    if (fallback.status === "ok" && fallback.search.offers.length > 0) return fallback;
  }
  if (ctx.lodgingResearch !== undefined) {
    const limit = perPersonNightLimitYen(budget, args.nights);
    const input = {
      // 検索の言葉には、県名を付けない市町村の名前を使う（宿の一覧のページに当たりやすい）
      festival: {
        name: festival.name.ja,
        place: festival.municipalities[0]?.name ?? placeLabel(festival),
        venueName: festival.venue.name,
      },
      stations: festival.access.stations.map((s) => s.name),
      checkIn: args.checkIn,
      nights: args.nights,
      party,
      perPersonNightLimitYen: limit,
    };
    const report = await ctx.lodgingResearch
      .research({
        festival: {
          id: festival.id,
          name: festival.name.ja,
          place: placeLabel(festival),
          venue: festival.venue,
        },
        checkIn: args.checkIn,
        nights: args.nights,
        party,
        perPersonNightLimitYen: limit,
        plans: lodgingSearchPlans(input),
        signal: AbortSignal.any([signal, AbortSignal.timeout(LODGING_RESEARCH_MS)]),
        ...(ctx.progress ? { onActivity: ctx.progress } : {}),
      })
      .catch(() => null);
    if (report !== null) {
      const searchedAt = ctx.now();
      const { offers } = screenResearchedLodging(report.reports, {
        venue,
        party,
        perPersonNightLimitYen: limit,
        checkedAt: searchedAt,
        today: ctx.today(),
      });
      if (offers.length > 0) {
        return {
          status: "ok",
          search: {
            checkIn: args.checkIn,
            checkOut: addDays(args.checkIn, args.nights),
            searchedAt,
            provider: "web",
            offers,
          },
        };
      }
    }
  }
  const fromOsm = osmLodging();
  if (fromOsm !== null) return fromOsm;
  return fallback ?? (await ctx.lodging.search(query, signal));
}

/** 人数を聞いていないときに、宿の候補を調べる人数 */
export const ASSUMED_LODGING_PARTY: Party = { adults: 2, children: 0 };

export const searchLodging = defineTool({
  name: "search_lodging",
  description:
    "泊まりの旅で、祭りの会場の近くに泊まる宿を調べて提案する。宿泊予約の API で空きと1泊の料金を調べ（安い順に5件まで）、" +
    "使えないときや空きがないときは、Web で観点（会場の近く・駅の近く・予算・家族向け）ごとに並べて調べ、突き合わせて1〜3件を選ぶ（provider が web）。" +
    "人数と宿の予算は聞き取った条件を使う（渡せば上書き）。人数を聞いていなければ大人2人として調べる（partyAssumed: true）。予算の合計と上限を超えるかは budget に計算して返す。" +
    "会場からの距離と移動の目安は fromVenue に計算して返す。" +
    "宿の名前・料金・予約のページは結果にあるものだけを使い、調べた時刻（searchedAt）と notice を必ず添えて伝える。" +
    "status が unavailable のときは宿の名前を出さず、泊まる地域だけを案内する。" +
    "結果は相談に残り、旅程を保存するとき、チェックインの日の泊まりに候補として付く。",
  input: {
    festivalId: SlugSchema.describe("祭りの ID（会場の近くを調べる）"),
    checkIn: IsoDateSchema.describe("チェックインの日"),
    nights: z.number().int().min(1).max(MAX_NIGHTS).describe("同じ宿に泊まる泊数"),
    radiusKm: z
      .number()
      .min(0.5)
      .max(MAX_SEARCH_RADIUS_KM)
      .optional()
      .describe(`空室検索の会場からの半径（km）。省略すると ${MAX_SEARCH_RADIUS_KM}`),
    party: PartySchema.optional().describe("人数。省略すると聞き取った条件の人数"),
    budget: LodgingBudgetSchema.optional().describe(
      "宿の予算の上限（1人あたり）。省略すると聞き取った条件の予算",
    ),
  },
  async run(args, ctx, signal) {
    const festival = festivalOf(ctx, args.festivalId);
    // 人数を聞き止めずに案を出す。聞いていなければ大人2人として調べ、そう伝える
    const heardParty = args.party ?? ctx.session.conditions.party;
    const party = heardParty ?? ASSUMED_LODGING_PARTY;
    const budget = args.budget ?? ctx.session.conditions.lodgingBudget;
    if (args.checkIn < ctx.today()) throw new ToolError("今日より前の日の宿は調べられません");
    const venue = { lat: festival.venue.lat, lng: festival.venue.lng };
    const outcome = await findLodging(ctx, festival, args, party, budget, signal);
    if (outcome.status === "unavailable") {
      return { status: "unavailable", reason: outcome.reason, checkIn: args.checkIn };
    }
    // 時間切れや接続の切断のあとに、相談の状態を書き換えない
    if (signal.aborted) throw new ToolError("止められたので、宿の候補は使いません");
    const search = withFromVenue(outcome.search, venue);
    const provider = search.provider ?? ctx.lodging.provider;
    ctx.session.lodging.set(search.checkIn, search);
    return {
      status: "ok",
      provider,
      checkIn: search.checkIn,
      checkOut: search.checkOut,
      searchedAt: search.searchedAt,
      notice: provider === "web" ? RESEARCHED_LODGING_NOTICE : LODGING_NOTICE,
      credit: provider === "rakuten" ? RAKUTEN_CREDIT : null,
      party,
      partyAssumed: heardParty === undefined,
      budget: budget ?? null,
      tripBudget:
        ctx.session.conditions.budget === undefined
          ? null
          : tripBudgetAmounts(ctx.session.conditions.budget, party),
      offers: search.offers.map((offer) => ({
        id: offer.id,
        name: offer.name,
        nightlyTotalYen: offer.nightlyTotalYen,
        perPersonNightYen: offer.perPersonNightYen ?? null,
        priceNote: offer.priceNote ?? null,
        summary: offer.summary ?? null,
        bookingUrl: offer.bookingUrl,
        fromVenue: offer.fromVenue ?? null,
        perspectives: offer.perspectives ?? [],
        sourceConfidence: offer.source.confidence,
        budget:
          offer.nightlyTotalYen === null
            ? null
            : checkLodgingBudget(offer.nightlyTotalYen, {
                party,
                nights: args.nights,
                budget,
                tripBudget: ctx.session.conditions.budget,
              }),
      })),
    };
  },
});

export const verifyFestival = defineTool({
  name: "verify_festival",
  description:
    "利用者が「決定」と言ったら、旅程を確定してしおりへ進める。" +
    "開催は候補を出す前に確かめてあり、その結果が旅程にあれば、それをそのまま使う（Web で調べ直さない）。" +
    "確かめた結果がないとき（行く日を変えた、確かめの上限に達したなど）だけ、Web と祭りのデータで確かめる。" +
    "結果は as_planned（公式で確認）/ needs_check（公式以外の情報源などで確認。要事前確認としてしおりを渡す）/ " +
    "changed（変更）/ cancelled（中止）/ not_found（どこにも情報がない。ほかの候補に戻る）。",
  input: {
    festivalId: SlugSchema.describe("祭りの ID"),
    date: IsoDateSchema.optional().describe("行く日。省略すると旅程の日"),
  },
  async run(args, ctx, signal) {
    const festival = festivalOf(ctx, args.festivalId);
    const date = visitDate(ctx, festival, args.date);
    const current = ctx.session.itineraryId
      ? ctx.itineraries.get(ctx.session.itineraryId)
      : undefined;
    const matches =
      current !== undefined &&
      current.mainFestivalId === festival.id &&
      mainFestivalDay(current).date === date;
    // 開催は候補を出す前に確かめてある。その結果（か前の決定の結果）があれば、調べ直さずに確定する
    const known = matches ? knownVerification(ctx, current, festival.id, date) : null;
    if (matches && known !== null) {
      if (!ctx.itineraries.saveForSession(ctx.session, { ...current, verification: known })) {
        throw new ToolError("旅が消されたので、旅程は保存しません");
      }
      ctx.turn.verification = known.status;
      return {
        festivalId: festival.id,
        date,
        result: known.status,
        checkedAt: known.checkedAt,
        sources: known.sources,
        ...(known.note ? { note: known.note } : {}),
        /** 確かめ済みの結果を使ったか（Web で調べ直していない） */
        reused: true,
        appliedToItinerary: true,
        daysUntil: daysBetween(ctx.today(), date),
        occurrenceInData: occurrenceOn(festival, date),
      };
    }
    // Web の確かめが失敗しても、祭りのデータの公式の出典で確かめてあれば、それで決める（decideVerification）
    let report: Awaited<ReturnType<ToolContext["verifier"]["verify"]>>;
    try {
      report = await ctx.verifier.verify({ festival, date, signal });
    } catch {
      report = { result: "not_found", sources: [], note: "時間内に確かめられませんでした" };
    }
    // 時間切れや接続の切断のあとに、再確認の結果で旅程を書き換えない
    if (signal.aborted) throw new ToolError("止められたので、再確認の結果は使いません");
    const decision = decideVerification(festival, report, ctx.today(), date);
    const checkedAt = ctx.now();
    const verification = {
      status: decision.result,
      checkedAt,
      sources: decision.sources,
      ...(decision.note ? { note: decision.note } : {}),
    };

    const applied = matches;
    if (applied) {
      if (!ctx.itineraries.saveForSession(ctx.session, { ...current, verification })) {
        throw new ToolError("旅が消されたので、旅程は保存しません");
      }
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
      reused: false,
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
  researchRoute,
  researchTrip,
  getWeather,
  searchLodging,
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
