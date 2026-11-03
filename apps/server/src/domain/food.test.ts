import { describe, expect, it } from "vitest";
import { foodEffects } from "./food";

describe("foodEffects", () => {
  it("何も聞いていなければ、決まりを足さず、店の食事も探さない", () => {
    expect(foodEffects({})).toEqual({ wantsShopMeals: false, rules: [] });
    expect(foodEffects({ foodWishes: [], dietary: [] })).toEqual({
      wantsShopMeals: false,
      rules: [],
    });
  });

  it("屋台のほかに食べたいものがあれば、店の食事も探し、食べたいものを決まりに書く", () => {
    const effects = foodEffects({ foodWishes: ["meat", "noodles"] });
    expect(effects.wantsShopMeals).toBe(true);
    expect(effects.rules).toHaveLength(1);
    expect(effects.rules[0]).toContain("肉料理・麺類");
  });

  it("屋台だけなら、店の食事は探さない", () => {
    const effects = foodEffects({ foodWishes: ["stalls"] });
    expect(effects.wantsShopMeals).toBe(false);
    expect(effects.rules[0]).toContain("屋台");
  });

  it("食事で気をつけたいことは、対応していると書かず店に確かめるよう決まりにする", () => {
    const effects = foodEffects({ dietary: ["vegetarian", "allergy"] });
    expect(effects.wantsShopMeals).toBe(false);
    expect(effects.rules).toHaveLength(1);
    expect(effects.rules[0]).toContain("ベジタリアン・食物アレルギー");
    expect(effects.rules[0]).toContain("確かめる");
  });
});
