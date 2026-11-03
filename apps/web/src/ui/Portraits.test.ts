import { describe, expect, it } from "vitest";
import { faceUrl, type Speaker } from "./Portraits";

describe("faceUrl", () => {
  it("話し手ごとに顔の絵がある（絵がないと会話の窓が空の丸になる）", () => {
    const speakers: Speaker[] = ["concierge", "researcher", "scout", "planner", "player"];
    for (const speaker of speakers) {
      expect(faceUrl(speaker), speaker).toMatch(/face_\w+\.webp/);
    }
  });
});
