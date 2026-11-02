// ツールのテストで使う文脈。架空の祭りと、ネットワークに出ない天気・再確認を入れる。
import type { Festival, Weather } from "@matsuri-ikoka/schema";
import { createFestivalStore } from "../data/festivalStore";
import type { VerificationReport } from "../domain/verification";
import { ItineraryStore, SessionStore } from "../session/sessionStore";
import { newTurnState, type ToolContext } from "./context";
import type { FestivalVerifier } from "./verifier";
import type { WeatherService } from "./weather";

export function testToolContext(
  festivals: Festival[],
  options: { today?: string; weather?: Weather; report?: VerificationReport } = {},
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
      return options.report ?? { result: "not_found", sources: [] };
    },
  };
  return {
    session: new SessionStore().create(),
    turn: newTurnState(),
    festivals: createFestivalStore(festivals),
    itineraries: new ItineraryStore(),
    weather,
    verifier,
    today: () => options.today ?? "2026-08-03",
    now: () => "2026-08-03T10:15:00+09:00",
    weatherCalls,
  };
}
