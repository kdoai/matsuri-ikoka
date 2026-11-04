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
  LocalTimeSchema,
  LodgingBudgetSchema,
  MAX_CANDIDATES,
  MAX_NIGHTS,
  MAX_TRIP_DAYS,
  MaxTravelMinutesSchema,
  MOVE_MODES,
  mainFestivalDay,
  NightsSchema,
  PartialTripConditionsSchema,
  PartySchema,
  PreferencesSchema,
  SlugSchema,
  type SpotPin,
  StayPlanSchema,
  tripBudgetAmounts,
  VerificationSchema,
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
  DESTINATION_STAGES,
  destinationLabel,
  destinationQuestion,
  destinationReason,
  knownDestinationNames,
  pickByDestination,
  resolveDestination,
} from "../domain/destination";
import { foodEffects } from "../domain/food";
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
import { attachLodging, checkLodgingBudget, distanceKm } from "../domain/lodging";
import { festivalInArea, selectNearbySpots, type TimeWindow } from "../domain/nearby";
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
} from "../domain/nearbySearch";
import { occurrenceOn } from "../domain/planCheck";
import { preferenceEffects } from "../domain/preferences";
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
import { type AgentToolName, TOOL_TIMEOUT_MS, type ToolContext } from "./context";
import { MAX_SEARCH_RADIUS_KM, RAKUTEN_CREDIT } from "./lodging";

// 接客エージェントに渡す8つのツール。入出力は Zod で決め、計算と絞り込みは domain の関数で行う。
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
  .omit({ id: true, version: true, verification: true, budget: true });

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
    "readyToSearch が true になったら祭りを探し始め、askNext の項目だけを聞く。",
  input: NoteConditionsInputSchema.shape,
  async run(args, ctx) {
    const given = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined),
    );
    if (args.destinations !== undefined) destinationOf(args.destinations);
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
    "今日より前の日・中止・掲載停止の祭りは出ない。日帰り（0泊）は移動の上限を超える祭りを除く。" +
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
    if (args.preferences !== undefined) session.preferences = args.preferences;
    const maxTravelMinutes = args.maxTravelMinutes ?? session.conditions.maxTravelMinutes;
    const destinations = args.destinations ?? session.conditions.destinations ?? [];
    const prefectures = destinationOf(destinations);
    // 聞き取りで書き留めたほかの条件（旅のかたち・ペースなど）は残す
    session.conditions = {
      ...session.conditions,
      when: args.when,
      origin: args.origin,
      nights: args.nights,
      ...(args.party === undefined ? {} : { party: args.party }),
      ...(maxTravelMinutes === undefined ? {} : { maxTravelMinutes }),
      ...(args.destinations === undefined ? {} : { destinations: args.destinations }),
    };

    const today = ctx.today();
    const ranges = searchRanges(args.when, today);
    const pool = ranges.expanded
      ? ctx.festivals.onDates(ranges.expanded.from, ranges.expanded.to)
      : [];
    const stations = ctx.stations;
    const origin = args.origin;
    const found = searchFestivalDates(pool, {
      wish: args.when,
      today,
      origin,
      nights: args.nights,
      preferences: session.preferences,
      ...(maxTravelMinutes === undefined ? {} : { maxTravelMinutes }),
      // 出発の駅の位置から、会場までの所要時間を見積もる（データに出発の駅からの所要時間がない祭りにも使う）
      ...(stations === undefined
        ? {}
        : {
            travelFor: (festival: Festival) =>
              estimateTravel({ access: festival.access, venue: festival.venue, origin }, stations),
          }),
      // 行き先で絞ってから数をそろえるので、ここでは減らさない
      limit: Number.POSITIVE_INFINITY,
    });

    // 行き先を守る：選んだ地域 → 隣接する県 → 全国の順。了承を得た段階より先へは広げず、問いを返す
    const label = destinationLabel(destinations);
    const placed = pickByDestination(found.matches, {
      prefectures,
      widen: args.widen ?? "area",
      random: ctx.random ?? Math.random,
    });
    if (placed.kind === "ask") {
      session.candidates = [];
      ctx.turn.searched = true;
      return {
        today,
        searchedRange: ranges,
        candidates: [],
        details: [],
        destination: {
          prefectures,
          stage: null,
          needsConsent: placed.next,
          foundIn: placed.foundIn,
          question: destinationQuestion(label, placed),
        },
        notes: [
          "候補はまだ出していません。destination.question をそのままお客さまに聞き、了承を得たら widen を広げて探し直してください",
        ],
      };
    }
    const poolSize = ctx.candidateChecks === undefined ? MAX_CANDIDATES : CANDIDATE_CHECK_POOL;
    const searched = {
      ...found,
      matches: placed.kind === "matches" ? placed.matches.slice(0, poolSize) : [],
    };

    // 候補を出す前に、開催日・時刻・状態を公式の情報で確かめる（並べて動かす）。
    // 出す数より多めに確かめ、確かめられた祭りを先に選ぶ
    const pooledChecks = await checkCandidates(ctx, searched.matches);
    const picked = pickVerifiedCandidates(
      searched.matches.map((match, index) => ({ match, check: pooledChecks[index] ?? null })),
      MAX_CANDIDATES,
      { requireInfo: ctx.candidateChecks !== undefined },
    );
    const result = { ...searched, matches: picked.map((p) => p.match) };
    const checks = picked.map((p) => p.check);
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
    const shown = new Set(result.matches.map((m) => m.festival.id));
    const unknown = result.travelUnknown.filter((id) => shown.has(id));
    const uncertain = result.travelUncertain.filter((id) => shown.has(id));
    if (maxTravelMinutes !== undefined && unknown.length > 0) {
      notes.push(
        `出発地からの所要時間が分からない祭りが${unknown.length}件あります。上限に収まるかは分からないと伝えてください`,
      );
    }
    if (uncertain.length > 0) {
      notes.push(
        `駅の位置からの見積もりでは、上限に収まるか境目の祭りが${uncertain.length}件あります。収まらないかもしれないと伝えてください`,
      );
    }
    const shownIds = new Set(picked.map((p) => p.match.festival.id));
    const withoutInfo = searched.matches.filter((m, index) => {
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
    if (candidates.length === 0) notes.push("条件に合う祭りはデータにありませんでした");
    const stage = placed.kind === "matches" ? placed.stage : null;
    const foundIn = placed.kind === "matches" ? placed.foundIn : [];
    const reason = stage === null ? null : destinationReason(label, stage, foundIn);
    if (reason !== null) notes.push(`候補を出すときに「${reason}」と添えてください`);

    return {
      today,
      searchedRange: ranges,
      candidates,
      ...(prefectures.length === 0
        ? {}
        : { destination: { prefectures, stage, needsConsent: null, foundIn, reason } }),
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
        // data：祭りのデータの所要時間 / estimate：駅の位置からの見積もり（目安と伝える）
        travelBasis: m.travelBasis,
        travelFit: m.travelFit,
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
export const NEARBY_FIRST_ROUND_MS = 55_000;
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
  };
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
): Promise<ResearchedSpotReport[] | null> {
  if (ctx.nearby === undefined) return null;
  const { conditions } = ctx.session;
  try {
    const report = await ctx.nearby.research({
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
      references: festival.nearby.map((s) => ({ name: s.name, kind: s.kind, summary: s.summary })),
      plan: nearbySearchPlan(search, round),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      ...(ctx.progress ? { onActivity: ctx.progress } : {}),
    });
    return report?.spots ?? null;
  } catch {
    return null;
  }
}

function researchedSpotOutput(s: ResearchedSpot) {
  return {
    ...spotOutput(s),
    origin: "web" as const,
    // confirmed：行く日の営業を確かめた / needs_check：確かめられなかった（行く前に要確認）
    openStatus: s.openStatus,
    matchedFoods: s.matchedFoods,
  };
}

/** 名前を比べる形にする（空白を除く） */
const sameName = (name: string) => name.replace(/\s+/g, "");

export const searchNearby = defineTool({
  name: "search_nearby",
  description:
    "祭りの前後に寄れる観光・食・休憩の場所を探す。周辺係が会場の周りを Web で調べ（祭りのデータの周辺の場所は参考にする）、" +
    "食べたいもの・食事で気をつけたいこと・予算・同行者に合い、行く日に営業している場所だけを返す（origin: web）。" +
    "行く日の営業を確かめられなかった場所は openStatus: needs_check になる。調べられなかったときは、祭りのデータの周辺の場所から選ぶ（research.status: fallback）。" +
    "当日が休業の場所、使える時間帯に営業時間が合わない場所、「屋台で十分」のときの店は除き、こだわりに合う順に返す。" +
    "食べたいものに合う店が1回目の調べで見つからなければ、場所と言葉を広げてもう1回調べる（research.rounds: 2）。" +
    "それでも見つからなければ research.foodFound が false になり、合わない店は返さない。車で回るときは、会場から遠い店も返す。" +
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
    ctx.session.selectedFestivalId = festival.id;
    const food = foodEffects(ctx.session.conditions);
    const selection = selectNearbySpots(festival.nearby, {
      date,
      preferences: ctx.session.preferences,
      wantsShopMeals: food.wantsShopMeals,
      ...(args.window === undefined ? {} : { window: args.window }),
    });
    const base = {
      festivalId: festival.id,
      date,
      localFood: festival.food.local.map((f) => ({ name: f.name, note: f.note ?? null })),
      stalls: festival.food.stalls,
      rules: [...preferenceEffects(ctx.session.preferences).rules, ...food.rules],
    };
    const search = nearbySearchInput(ctx, festival, args.window);
    const started = Date.now();
    const first = await researchNearby(
      ctx,
      festival,
      date,
      search,
      "first",
      NEARBY_FIRST_ROUND_MS,
      signal,
    );
    if (signal.aborted) throw new ToolError("止められたので、寄り道の結果は使いません");
    if (first === null) {
      return {
        ...base,
        research: {
          status: ctx.nearby === undefined ? "data_only" : "fallback",
          foodFound: null,
          rounds: ctx.nearby === undefined ? 0 : 1,
        },
        spots: selection.spots.map((spot) => ({ ...spotOutput(spot), origin: "data" as const })),
        excluded: selection.excluded,
        notes:
          ctx.nearby === undefined
            ? []
            : ["会場の周りを Web で調べられなかったので、祭りのデータの周辺の場所から選びました"],
      };
    }

    const { conditions } = ctx.session;
    const screen = (reports: readonly ResearchedSpotReport[]) =>
      screenResearchedSpots(reports, {
        date,
        ...(args.window === undefined ? {} : { window: args.window }),
        venue: festival.venue,
        maxKm: maxSpotKm(search.byCar),
        today: ctx.today(),
        preferences: ctx.session.preferences,
        foodWishes: conditions.foodWishes ?? [],
        dietary: conditions.dietary ?? [],
        perPersonBudgetYen:
          conditions.budget === undefined
            ? null
            : tripBudgetAmounts(conditions.budget, conditions.party).perPersonYen,
        party: conditions.party ?? null,
      });
    let screened = screen(first);
    let rounds = 1;
    // 食べたいものに合う店が1つもなければ、時間の残りがあるときだけ、場所と言葉を広げてもう1回調べる
    const remaining = NEARBY_RESEARCH_MS - (Date.now() - started);
    if (screened.foodFound === false && remaining >= NEARBY_WIDEN_MIN_MS) {
      const widened = await researchNearby(
        ctx,
        festival,
        date,
        search,
        "widened",
        remaining,
        signal,
      );
      if (signal.aborted) throw new ToolError("止められたので、寄り道の結果は使いません");
      rounds = 2;
      if (widened !== null) screened = screen(mergeResearchedReports(first, widened));
    }
    // 旅程を保存するとき、祭りのデータの場所と同じく照らせるよう、調べた場所を相談に残す
    for (const spot of screened.spots) ctx.session.researchedSpots.set(spot.id, asNearbySpot(spot));
    // 祭りのデータの店は、出す料理が分からないので、食べたいものがあるときは調べた店だけにする
    const wanted = shopFoodWishes(conditions.foodWishes ?? []);
    const researchedNames = new Set(screened.spots.map((spot) => sameName(spot.name)));
    const dataSpots = selection.spots.filter(
      (spot) =>
        !(wanted.length > 0 && spot.kind === "food") && !researchedNames.has(sameName(spot.name)),
    );
    const notes: string[] = [];
    if (screened.foodFound === false) {
      notes.push(
        "食べたいものに合う店は、調べても見つかりませんでした。合わない店で埋めず、見つからなかったと伝えてください（屋台と地元の味は localFood・stalls にあります）",
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

export const researchRoute = defineTool({
  name: "research_route",
  description:
    "出発の駅から祭りの会場の最寄り駅までの電車の行き方（乗る路線・乗り換え・所要時間の幅）を、公開の情報で調べる。" +
    "調べた所要時間は、駅の位置からの見積もりと照らし、食い違うものは使わない（その場合は見積もりを返す）。" +
    "旅程の最初の移動（出発の駅から）の move.minutes と name・reason に使う。同じ祭りで呼び直さない。",
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
  },
  async run(args, ctx, signal) {
    const festival = festivalOf(ctx, args.festivalId);
    const origin = args.origin ?? ctx.session.conditions.origin;
    if (origin === undefined)
      throw new ToolError("出発の駅が分かりません。先に出発の駅を聞いてください");
    const date = visitDate(ctx, festival, args.date);
    const estimate = travelEstimateFor(ctx, festival, origin);
    const to = destinationStation(ctx, festival);
    const walk = festival.access.stations[0]?.walkMinutes ?? null;
    const base = {
      festivalId: festival.id,
      origin,
      destinationStation: to,
      walkMinutesFromStationEstimate: walk,
      estimate: estimate === null ? null : { minutes: estimate.minutes, basis: estimate.basis },
      rules: [
        `旅程の最初の予定は、出発の駅（${origin}）からの移動（type: "move"）にし、name に出発の駅の名前を入れる`,
        "move.minutes には、researched があればその minutes、なければ estimate の minutes をそのまま使い、estimate: true にする",
      ],
    };
    const sameStation = to !== null && normalizeStationName(to) === normalizeStationName(origin);
    if (ctx.routes === undefined || to === null || sameStation) {
      return { ...base, status: "estimate_only", researched: null };
    }
    let report: Awaited<ReturnType<NonNullable<ToolContext["routes"]>["research"]>> = null;
    try {
      report = await ctx.routes.research({
        from: origin,
        to,
        date,
        ...(args.arriveBy ? { arriveBy: args.arriveBy } : {}),
        signal,
      });
    } catch {
      report = null;
    }
    if (signal.aborted) throw new ToolError("止められたので、行き方の結果は使いません");
    if (report === null) return { ...base, status: "not_found", researched: null };
    const checked = checkResearchedMinutes(report.minutes, estimate);
    if (!checked.ok) {
      return { ...base, status: "rejected", reason: checked.reason, researched: null };
    }
    return {
      ...base,
      status: "researched",
      researched: {
        minutes: checked.minutes,
        summary: report.summary,
        transfers: report.transfers,
        sources: report.sources,
      },
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
    "後ろに足すときは、それまでの最後の日の夜に泊まる地域を stayBefore に書く。保存のたびに画面の旅程が更新される。" +
    "stay に宿の名前は書かない。search_lodging で調べた宿の候補は、チェックインの日の stay にサーバーが付ける。",
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
        return { saved: false, errors: startIssues, warnings: [] };
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

    const result = buildItinerary(draft, {
      id: previous?.id ?? randomId("trip"),
      previous,
      budget: session.conditions.budget,
      weatherFor: (date) => weatherByDate.get(date) ?? { status: "unavailable" },
      findFestival: (id) => ctx.festivals.get(id),
      // 周辺係が調べた場所も照らす。前の版に入っている調べた場所は、相談を戻したあとでも直せるよう前の版から引く
      extraSpots: new Map([
        ...(previous === null ? [] : researchedSpotsInItinerary(previous)),
        ...session.researchedSpots,
      ]),
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
    const itinerary = result.itinerary;
    if (!result.unchanged) {
      ctx.itineraries.save(itinerary);
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
      warnings: result.warnings,
      itinerary,
    };
  },
});

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

export const searchLodging = defineTool({
  name: "search_lodging",
  description:
    "泊まりの旅で、祭りの会場の近くの宿の空きと1泊の料金を、宿泊予約の API で調べる（安い順に5件まで）。" +
    "人数と宿の予算は聞き取った条件を使う（渡せば上書き）。予算の合計と上限を超えるかは budget に計算して返す。" +
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
      .describe(`会場からの半径（km）。省略すると ${MAX_SEARCH_RADIUS_KM}`),
    party: PartySchema.optional().describe("人数。省略すると聞き取った条件の人数"),
    budget: LodgingBudgetSchema.optional().describe(
      "宿の予算の上限（1人あたり）。省略すると聞き取った条件の予算",
    ),
  },
  async run(args, ctx, signal) {
    const festival = festivalOf(ctx, args.festivalId);
    const party = args.party ?? ctx.session.conditions.party;
    if (party === undefined) {
      throw new ToolError("人数が分かりません。大人と子どもの人数を聞いてから調べてください");
    }
    const budget = args.budget ?? ctx.session.conditions.lodgingBudget;
    if (args.checkIn < ctx.today()) throw new ToolError("今日より前の日の宿は調べられません");
    const venue = { lat: festival.venue.lat, lng: festival.venue.lng };
    const outcome = await ctx.lodging.search(
      {
        checkIn: args.checkIn,
        nights: args.nights,
        party,
        near: venue,
        radiusKm: args.radiusKm ?? MAX_SEARCH_RADIUS_KM,
      },
      signal,
    );
    if (outcome.status === "unavailable") {
      return { status: "unavailable", reason: outcome.reason, checkIn: args.checkIn };
    }
    // 時間切れや接続の切断のあとに、相談の状態を書き換えない
    if (signal.aborted) throw new ToolError("止められたので、宿の空きは使いません");
    const { search } = outcome;
    ctx.session.lodging.set(search.checkIn, search);
    return {
      status: "ok",
      provider: ctx.lodging.provider,
      checkIn: search.checkIn,
      checkOut: search.checkOut,
      searchedAt: search.searchedAt,
      notice: LODGING_NOTICE,
      credit: ctx.lodging.provider === "rakuten" ? RAKUTEN_CREDIT : null,
      party,
      budget: budget ?? null,
      tripBudget:
        ctx.session.conditions.budget === undefined
          ? null
          : tripBudgetAmounts(ctx.session.conditions.budget, party),
      offers: search.offers.map((offer) => ({
        id: offer.id,
        name: offer.name,
        nightlyTotalYen: offer.nightlyTotalYen,
        bookingUrl: offer.bookingUrl,
        distanceKmFromVenue: offer.location === null ? null : distanceKm(venue, offer.location),
        budget: checkLodgingBudget(offer.nightlyTotalYen, {
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
      ctx.itineraries.save({ ...current, verification: known });
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
      ctx.itineraries.save({ ...current, verification });
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
