// ツールのテストで使う文脈。架空の祭りと、ネットワークに出ない天気・再確認を入れる。
import type { Festival, Weather } from "@matsuri-ikoka/schema";
import { createFestivalStore } from "../data/festivalStore";
import type { StationPointIndex } from "../domain/travelEstimate";
import type { VerificationReport } from "../domain/verification";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { newTurnState, type ToolContext } from "./context";
import { createFictionalLodging, type LodgingService } from "./lodging";
import type { RouteResearcher } from "./routeResearch";
import type { FestivalVerifier } from "./verifier";
import type { WeatherService } from "./weather";

export function testToolContext(
  festivals: Festival[],
  options: {
    today?: string;
    weather?: Weather;
    report?: VerificationReport;
    signal?: AbortSignal;
    lodging?: LodgingService;
    /** 再確認が失敗する（時間切れなど）ときに投げるエラー */
    verifyError?: Error;
    stations?: StationPointIndex;
    routes?: RouteResearcher;
  } = {},
): ToolContext & { weatherCalls: string[] } {
  const weatherCalls: string[] = [];
  const weather: WeatherService = {
    async forecast(prefecture, date) {
      weatherCalls.push(`${prefecture}@${date}`);
      return { weather: options.weather ?? { status: "not_yet" }, area: null };
    },
  };
  const verifier: FestivalVerifier = {
    async verify() {
      if (options.verifyError) throw options.verifyError;
      return options.report ?? { result: "not_found", sources: [] };
    },
  };
  return {
    session: new SessionStore().create(),
    turn: newTurnState(),
    signal: options.signal ?? new AbortController().signal,
    festivals: createFestivalStore(festivals),
    itineraries: new ItineraryStore(),
    weather,
    lodging: options.lodging ?? createFictionalLodging({ now: () => "2026-08-03T10:15:00+09:00" }),
    verifier,
    ...(options.stations ? { stations: options.stations } : {}),
    ...(options.routes ? { routes: options.routes } : {}),
    today: () => options.today ?? "2026-08-03",
    now: () => "2026-08-03T10:15:00+09:00",
    weatherCalls,
  };
}
