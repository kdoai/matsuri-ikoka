import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCATION_WAIT_MS, readLocationOnce } from "./location";

afterEach(() => {
  vi.useRealTimers();
});

describe("readLocationOnce", () => {
  it("読めたら、その位置を返す", async () => {
    const geolocation = {
      getCurrentPosition: (ok: PositionCallback) =>
        ok({ coords: { latitude: 35.123456, longitude: 136.567891 } } as GeolocationPosition),
    };
    expect(await readLocationOnce(geolocation)).toEqual({ lat: 35.123456, lng: 136.567891 });
  });

  it("断られたら null（推測しない）", async () => {
    const geolocation = {
      getCurrentPosition: (_ok: PositionCallback, fail?: PositionErrorCallback | null) =>
        fail?.({ code: 1 } as GeolocationPositionError),
    };
    expect(await readLocationOnce(geolocation)).toBeNull();
  });

  it("許可の窓を答えずに閉じて何も返ってこなくても、待つ時間を過ぎたら null で戻る", async () => {
    vi.useFakeTimers();
    const geolocation = { getCurrentPosition: () => undefined };
    const read = readLocationOnce(geolocation);
    await vi.advanceTimersByTimeAsync(LOCATION_WAIT_MS);
    expect(await read).toBeNull();
  });

  it("位置を読めない端末では、すぐ null", async () => {
    expect(await readLocationOnce(undefined)).toBeNull();
  });
});
