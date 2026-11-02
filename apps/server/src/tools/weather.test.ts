import { describe, expect, it } from "vitest";
import { createJmaWeather, readForecast } from "./weather";

// 気象庁の予報 JSON と同じ形の、架空の値の予報（短期の3日と、週間の7日）
function forecastJson() {
  return [
    {
      timeSeries: [
        {
          timeDefines: [
            "2026-08-03T11:00:00+09:00",
            "2026-08-04T00:00:00+09:00",
            "2026-08-05T00:00:00+09:00",
          ],
          areas: [
            {
              area: { name: "南部", code: "250010" },
              weatherCodes: ["100", "201", "300"],
              weathers: ["晴れ", "くもり　時々　晴れ", "雨"],
            },
          ],
        },
        {
          timeDefines: [
            "2026-08-04T00:00:00+09:00",
            "2026-08-04T06:00:00+09:00",
            "2026-08-04T12:00:00+09:00",
            "2026-08-04T18:00:00+09:00",
          ],
          areas: [{ area: { name: "南部", code: "250010" }, pops: ["10", "20", "40", "30"] }],
        },
      ],
    },
    {
      timeSeries: [
        {
          timeDefines: [
            "2026-08-04T00:00:00+09:00",
            "2026-08-07T00:00:00+09:00",
            "2026-08-10T00:00:00+09:00",
          ],
          areas: [
            {
              area: { name: "南部", code: "250010" },
              weatherCodes: ["201", "101", "300"],
              pops: ["", "30", "70"],
            },
          ],
        },
        {
          timeDefines: [
            "2026-08-04T00:00:00+09:00",
            "2026-08-07T00:00:00+09:00",
            "2026-08-10T00:00:00+09:00",
          ],
          areas: [
            {
              area: { name: "大津", code: "60216" },
              tempsMin: ["", "24", "23"],
              tempsMax: ["", "33", "29"],
            },
          ],
        },
      ],
    },
  ];
}

const read = (date: string) =>
  readForecast(forecastJson(), {
    date,
    today: "2026-08-03",
    officeCode: "250000",
    checkedAt: "2026-08-03",
  });

describe("readForecast", () => {
  it("3日先までは府県天気予報の文と、その日の降水確率のいちばん高い値を使う", () => {
    const { weather, area } = read("2026-08-04");

    expect(area).toBe("南部");
    expect(weather).toMatchObject({
      status: "forecast",
      summary: "くもり 時々 晴れ",
      precipitationPercent: 40,
      source: {
        url: "https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=250000",
        confidence: "official",
      },
    });
  });

  it("それより先は週間予報から、天気の大まかな分類と気温を使う", () => {
    expect(read("2026-08-07").weather).toMatchObject({
      status: "forecast",
      summary: "晴れが中心（週間予報）",
      precipitationPercent: 30,
      highC: 33,
      lowC: 24,
    });
  });

  it("予報の範囲より先の日は「予報前」、形の違う JSON は「取得できなかった」", () => {
    expect(read("2026-08-16").weather).toEqual({ status: "not_yet" });
    expect(
      readForecast(
        { unexpected: true },
        { date: "2026-08-04", today: "2026-08-03", officeCode: "250000", checkedAt: "2026-08-03" },
      ).weather,
    ).toEqual({
      status: "unavailable",
    });
  });
});

describe("createJmaWeather", () => {
  it("地域ごとに30分キャッシュする", async () => {
    let calls = 0;
    let now = 0;
    const weather = createJmaWeather({
      now: () => now,
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify(forecastJson()));
      }) as typeof fetch,
    });

    await weather.forecast("滋賀県", "2026-08-04", "2026-08-03");
    await weather.forecast("滋賀県", "2026-08-07", "2026-08-03");
    now = 31 * 60 * 1000;
    await weather.forecast("滋賀県", "2026-08-04", "2026-08-03");

    expect(calls).toBe(2);
  });

  it("取得に失敗したら「取得できなかった」を返し、失敗はキャッシュしない", async () => {
    let calls = 0;
    const weather = createJmaWeather({
      fetch: (async () => {
        calls += 1;
        return new Response("", { status: 503 });
      }) as typeof fetch,
    });

    expect((await weather.forecast("滋賀県", "2026-08-04", "2026-08-03")).weather).toEqual({
      status: "unavailable",
    });
    await weather.forecast("滋賀県", "2026-08-04", "2026-08-03");
    expect(calls).toBe(2);
  });

  it("時間の上限で打ち切る", async () => {
    const weather = createJmaWeather({
      timeoutMs: 20,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
    });

    expect((await weather.forecast("滋賀県", "2026-08-04", "2026-08-03")).weather).toEqual({
      status: "unavailable",
    });
  });
});
