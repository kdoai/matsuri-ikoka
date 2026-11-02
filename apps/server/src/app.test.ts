import { describe, expect, it } from "vitest";
import { createApp } from "./app";

describe("GET /healthz", () => {
  it("死活監視に ok を返す", async () => {
    const res = await createApp().request("/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
