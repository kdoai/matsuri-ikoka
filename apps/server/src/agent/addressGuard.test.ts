import { describe, expect, it } from "vitest";
import { checkHostAddresses, isInternalAddress } from "./addressGuard";

describe("isInternalAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "not-an-address",
  ])("%s は内側として断る", (address) => {
    expect(isInternalAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "%s は外の Web として通す",
    (address) => {
      expect(isInternalAddress(address)).toBe(false);
    },
  );
});

describe("checkHostAddresses", () => {
  it("公開の名前でも、内側のアドレスを指していれば断る", async () => {
    const result = await checkHostAddresses("169.254.169.254.nip.io", async () => [
      "169.254.169.254",
    ]);

    expect(result).toEqual({ ok: false, reason: "内側のネットワークを指す名前です" });
  });

  it("アドレスが1つでも内側なら断る", async () => {
    const result = await checkHostAddresses("mixed.example", async () => ["8.8.8.8", "10.0.0.1"]);

    expect(result.ok).toBe(false);
  });

  it("解決できない名前は断る", async () => {
    const failed = await checkHostAddresses("missing.example", async () => {
      throw new Error("ENOTFOUND");
    });
    const empty = await checkHostAddresses("empty.example", async () => []);

    expect(failed).toEqual({ ok: false, reason: "名前を解決できません" });
    expect(empty.ok).toBe(false);
  });

  it("外の Web だけを指していれば通す", async () => {
    expect(await checkHostAddresses("public.example", async () => ["8.8.8.8"])).toEqual({
      ok: true,
    });
  });
});
