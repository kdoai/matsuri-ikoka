import { STAFF_IDS } from "@matsuri-ikoka/schema";
import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import { createPlayStore, isConsultDesk } from "./play";

describe("話しかける相手", () => {
  it("相談の窓口はコンシェルジュだけ", () => {
    expect(STAFF_IDS.filter(isConsultDesk)).toEqual(["concierge"]);
  });

  it("ほかのスタッフに話しかけると、そのスタッフのおしゃべりになる", () => {
    const store = createPlayStore();
    store.getState().chat("scout");
    expect(store.getState().chatter).toEqual({ seq: 1, staff: "scout", line: 0 });
  });

  it("話しかけるたびに、そのスタッフの次のセリフになる", () => {
    const store = createPlayStore();
    store.getState().chat("scout");
    store.getState().chat("scout");
    expect(store.getState().chatter).toEqual({ seq: 2, staff: "scout", line: 1 });
    // ほかのスタッフは、そのスタッフの最初のセリフから
    store.getState().chat("planner");
    expect(store.getState().chatter).toEqual({ seq: 3, staff: "planner", line: 0 });
    store.getState().chat("scout");
    expect(store.getState().chatter).toEqual({ seq: 4, staff: "scout", line: 2 });
  });

  it("おしゃべりのセリフは、コンシェルジュ以外のスタッフごとに、どの言語にもある", () => {
    for (const messages of [ja, en]) {
      for (const id of STAFF_IDS) {
        if (isConsultDesk(id)) continue;
        expect(messages.play.chatter[id].length).toBeGreaterThan(0);
      }
    }
    expect(Object.keys(en.play.chatter).sort()).toEqual(Object.keys(ja.play.chatter).sort());
  });
});
