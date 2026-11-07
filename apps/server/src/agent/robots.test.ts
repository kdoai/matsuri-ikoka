import { describe, expect, it } from "vitest";
import { createRobotsChecker, isPathAllowed, parseRobots, ROBOTS_CACHE_TTL_MS } from "./robots";

describe("parseRobots と isPathAllowed", () => {
  it("* の組の決まりを読み、いちばん長く当たった決まりで決める", () => {
    const rules = parseRobots(`
User-agent: other-bot
Disallow: /

User-agent: *
Disallow: /private/
Allow: /private/menu.html
Disallow: /*.pdf$
`);
    expect(isPathAllowed(rules, "/menu.html")).toBe(true);
    expect(isPathAllowed(rules, "/private/staff.html")).toBe(false);
    expect(isPathAllowed(rules, "/private/menu.html")).toBe(true);
    expect(isPathAllowed(rules, "/guide.pdf")).toBe(false);
    expect(isPathAllowed(rules, "/guide.pdf?page=1")).toBe(true);
  });

  it("自分の名前の組があれば、* より優先する", () => {
    const rules = parseRobots(`
User-agent: *
Disallow: /

User-agent: matsuri-ikoka
Disallow: /admin/
`);
    expect(isPathAllowed(rules, "/shop")).toBe(true);
    expect(isPathAllowed(rules, "/admin/x")).toBe(false);
  });

  it("並んだ User-agent は同じ組として読み、空の Disallow はすべて許す", () => {
    const shared = parseRobots("User-agent: a\nUser-agent: *\nDisallow: /x\n");
    expect(isPathAllowed(shared, "/x")).toBe(false);
    expect(isPathAllowed(parseRobots("User-agent: *\nDisallow:\n"), "/x")).toBe(true);
  });

  it("全部を断るサイトは読まない", () => {
    expect(isPathAllowed(parseRobots("User-agent: *\nDisallow: /\n"), "/shop")).toBe(false);
  });

  it.each([
    ["/a*b", "/a-x-b-y", false],
    ["/a*b", "/ax", true],
    ["/a*b", "/b/a", true],
    ["/a*b*c", "/a1b2c3", false],
    ["/a*b*c", "/a1c2b", true],
    ["/a**b", "/a1b", false],
    ["/*", "/anything", false],
    ["/*$", "/anything", false],
    ["/*.pdf$", "/x.pdf", false],
    ["/*.pdf$", "/x.pdf?page=1", true],
    ["/*.pdf$", "/.pdf.txt", true],
    ["/a*a$", "/a", true],
    ["/a*a$", "/aa", false],
    ["/a$", "/a", false],
    ["/a$", "/ab", true],
    ["/a$b", "/a$b/c", false],
    ["/a.b", "/axb", true],
    ["/(x", "/(x/y", false],
  ])("Disallow: %s に %s は、読んでよいが %s", (rule, path, allowed) => {
    const rules = parseRobots(`User-agent: *\nDisallow: ${rule}\n`);
    expect(isPathAllowed(rules, path)).toBe(allowed);
  });

  it.each([
    ["* が多く並ぶ", `/${"*".repeat(400)}Q`],
    ["* と文字が交互に並ぶ", `/${"*a".repeat(240)}Q`],
    ["末尾が $ の", `/${"*".repeat(400)}Q$`],
  ])("%s決まりでも、すぐに終わる", (_name, rule) => {
    const rules = parseRobots(`User-agent: *\nDisallow: ${rule}\n`);
    const started = performance.now();

    expect(isPathAllowed(rules, `/${"a".repeat(2_000)}`)).toBe(true);

    expect(performance.now() - started).toBeLessThan(200);
  });

  it("長すぎる決まりは使わず、決まりの数にも上限がある", () => {
    const long = parseRobots(`User-agent: *\nDisallow: /${"a".repeat(600)}\nDisallow: /x\n`);
    expect(long).toEqual([{ allow: false, path: "/x" }]);

    const many = Array.from({ length: 1_500 }, (_, i) => `Disallow: /p${i}`).join("\n");
    expect(parseRobots(`User-agent: *\n${many}\n`)).toHaveLength(1_000);
  });
});

describe("createRobotsChecker", () => {
  const url = new URL("https://example.com/private/a");

  it("サイトごとに1回だけ聞き、転送はたどらず、時間が過ぎたら聞き直す", async () => {
    let now = 0;
    const calls: { url: string; redirect?: RequestInit["redirect"] }[] = [];
    const checker = createRobotsChecker({
      clock: () => now,
      fetch: (async (target: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(target), redirect: init?.redirect });
        return new Response("User-agent: *\nDisallow: /private/\n");
      }) as typeof fetch,
    });

    expect(await checker.allowed(url)).toBe(false);
    expect(await checker.allowed(new URL("https://example.com/open"))).toBe(true);
    expect(calls).toEqual([{ url: "https://example.com/robots.txt", redirect: "manual" }]);

    now = ROBOTS_CACHE_TTL_MS + 1;
    await checker.allowed(url);
    expect(calls).toHaveLength(2);
  });

  it("本文は上限のバイト数までしか読まない", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`${"# 読まない行\n".repeat(4_000)}`);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const checker = createRobotsChecker({
      fetch: (async () => new Response(endless)) as typeof fetch,
    });

    expect(await checker.allowed(url)).toBe(true);

    expect(pulled * chunk.byteLength).toBeLessThan(400_000);
  });

  it("上限の中の決まりは読み、文字の途中で切れても失敗しない", async () => {
    const body = `User-agent: *\nDisallow: /private/\n${"# 祭り\n".repeat(50_000)}`;
    const checker = createRobotsChecker({
      fetch: (async () => new Response(body)) as typeof fetch,
    });

    expect(await checker.allowed(url)).toBe(false);
  });

  it("読まない本文は片付ける", async () => {
    const response = new Response("not found", { status: 404 });
    const checker = createRobotsChecker({ fetch: (async () => response) as typeof fetch });

    await checker.allowed(url);

    // 片付けると、本文はもう読めない
    expect(response.bodyUsed || response.body?.locked === false).toBe(true);
    await expect(response.body?.getReader().read()).resolves.toMatchObject({ done: true });
  });

  it("robots.txt がない・読めない・転送されるときは、読んでよいとする", async () => {
    const answers: (() => Response)[] = [
      () => new Response("not found", { status: 404 }),
      () => {
        throw new Error("network");
      },
      () => new Response(null, { status: 302, headers: { location: "https://other.example/" } }),
    ];
    for (const answer of answers) {
      const checker = createRobotsChecker({ fetch: (async () => answer()) as typeof fetch });
      expect(await checker.allowed(url)).toBe(true);
    }
  });
});
