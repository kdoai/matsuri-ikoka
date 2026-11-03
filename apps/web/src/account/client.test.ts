import { describe, expect, it, vi } from "vitest";
import { createPasscodeHolder, PASSCODE_HEADER } from "../transport/server";
import { TransportError } from "../transport/types";
import { createAccountClient } from "./client";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createAccountClient", () => {
  it("ログインを用意していなければ、ログインを出さず、旅の API も呼ばない", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ enabled: false }));
    const client = createAccountClient({ fetch });
    const users: unknown[] = [];

    expect(await client.enabled()).toBe(false);
    client.onUser((user) => users.push(user));
    await expect(client.listTrips()).rejects.toBeInstanceOf(TransportError);
    await vi.waitFor(() => expect(users).toEqual([null]));
    expect(fetch.mock.calls.every(([path]) => path === "/api/auth/config")).toBe(true);
  });

  it("設定は合言葉を付けて読み、断られたら次に読み直す", async () => {
    const passcode = createPasscodeHolder();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({ code: "unauthorized", message: "合言葉が違います。", retryable: false }, 401),
      )
      .mockResolvedValueOnce(json({ enabled: false }));
    const client = createAccountClient({ passcode, fetch });

    expect(await client.enabled()).toBe(false);
    passcode.set("matsuri");
    expect(await client.enabled()).toBe(false);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get(PASSCODE_HEADER)).toBe("matsuri");
  });

  it("形の違う設定は、ログインなしとして扱う", async () => {
    const client = createAccountClient({ fetch: async () => json({ enabled: true }) });
    expect(await client.enabled()).toBe(false);
  });
});
