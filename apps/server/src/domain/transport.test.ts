import { describe, expect, it } from "vitest";
import { transportEffects } from "./transport";

describe("transportEffects", () => {
  it("選んでいなければ、決まりを足さない", () => {
    expect(transportEffects({})).toEqual({ usesCar: false, rules: [] });
    expect(transportEffects({ transport: [] })).toEqual({ usesCar: false, rules: [] });
  });

  it("選んだ交通手段で道のりを組む決まりを作る", () => {
    const effects = transportEffects({ transport: ["shinkansen", "local_train", "walk"] });

    expect(effects.usesCar).toBe(false);
    expect(effects.rules).toHaveLength(1);
    expect(effects.rules[0]).toContain("想定している交通手段（新幹線・在来線・徒歩）");
  });

  it("車かレンタカーを選んだら、駐車場と交通規制を先に確かめる", () => {
    for (const mode of ["car", "rental_car"] as const) {
      const effects = transportEffects({ transport: [mode] });
      expect(effects.usesCar).toBe(true);
      expect(effects.rules.join("\n")).toContain("駐車場と交通規制を先に確かめる");
    }
  });

  it("バス・船・飛行機の便と時刻は、データにないので書かない", () => {
    const effects = transportEffects({ transport: ["plane", "ferry", "bus"] });

    expect(effects.rules.join("\n")).toContain("飛行機・船・バスの便と時刻はデータにない");
  });
});
