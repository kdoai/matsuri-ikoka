import type { LatLng } from "@matsuri-ikoka/schema";

// 端末の現在地を、利用者が頼んだときだけ1回読む。保存しない。丸めるのは送る側（ストアの sendGuide）。

/** 位置の許可の窓に答えずに閉じると、成功も失敗も呼ばないブラウザがある。この時間で読めないとみなす */
export const LOCATION_WAIT_MS = 15_000;

/** 現在地を1回だけ読む。断られた・読めない・時間切れなら null（推測で埋めない） */
export function readLocationOnce(
  geolocation: Pick<Geolocation, "getCurrentPosition"> | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator.geolocation,
  waitMs = LOCATION_WAIT_MS,
): Promise<LatLng | null> {
  if (geolocation === undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: LatLng | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    geolocation.getCurrentPosition(
      (position) => finish({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => finish(null),
      // 細かさは要らない（丸めて送る）。古い位置は使わない
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 0 },
    );
  });
}
