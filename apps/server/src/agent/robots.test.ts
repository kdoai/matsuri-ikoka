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
