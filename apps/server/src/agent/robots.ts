// 調べ役が読むページの robots.txt を確かめる。サイトが読まないでほしいと書いているページは読まない。
// robots.txt がない・読めないときは、読んでよいとして扱う（調べを止めない）。
// 問い合わせはサイトごとに1回だけにし、転送はたどらない（宛先の確認を通っていない先へ行かないため）。

export const ROBOTS_USER_AGENT = "matsuri-ikoka";
/** robots.txt の問い合わせを打ち切る時間（ミリ秒） */
const ROBOTS_TIMEOUT_MS = 3_000;
/** とっておく時間 */
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 読む robots.txt の大きさの上限（文字） */
const MAX_ROBOTS_LENGTH = 200_000;

interface Rule {
  allow: boolean;
  path: string;
}

/** robots.txt から、自分に当てはまる決まりを取り出す。自分の名前の組があればそれを、なければ * の組を使う */
export function parseRobots(text: string, agent: string = ROBOTS_USER_AGENT): Rule[] {
  const named: Rule[] = [];
  const wildcard: Rule[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = (raw.split("#")[0] ?? "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      // 空の Disallow は「すべて許す」なので決まりにしない
      if (value === "") continue;
      const rule = { allow: key === "allow", path: value };
      if (agents.includes(agent.toLowerCase())) named.push(rule);
      if (agents.includes("*")) wildcard.push(rule);
    }
  }
  return named.length > 0 ? named : wildcard;
}

/** * と $ を含む決まりの道筋が、URL の道筋に当たるか */
function matches(rulePath: string, path: string): boolean {
  const pattern = rulePath
    .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\\?\$$/, "$");
  return new RegExp(`^${pattern}`).test(path);
}

/** いちばん長く当たった決まりで決める。同じ長さなら Allow を優先する。当たらなければ読んでよい */
export function isPathAllowed(rules: readonly Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matches(rule.path, path)) continue;
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best?.allow ?? true;
}

export interface RobotsChecker {
  allowed(url: URL): Promise<boolean>;
}

export function createRobotsChecker(
  options: { fetch?: typeof fetch; clock?: () => number } = {},
): RobotsChecker {
  const send = options.fetch ?? fetch;
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, { rules: Rule[]; expiresAt: number }>();

  async function rulesFor(origin: string): Promise<Rule[]> {
    const hit = cache.get(origin);
    if (hit !== undefined && hit.expiresAt > clock()) return hit.rules;
    let rules: Rule[] = [];
    try {
      const response = await send(`${origin}/robots.txt`, {
        redirect: "manual",
        headers: { "User-Agent": `${ROBOTS_USER_AGENT}/0.1` },
        signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      });
      if (response.status === 200) {
        rules = parseRobots((await response.text()).slice(0, MAX_ROBOTS_LENGTH));
      }
    } catch {
      // 読めなければ決まりなしとして扱う
    }
    cache.set(origin, { rules, expiresAt: clock() + ROBOTS_CACHE_TTL_MS });
    return rules;
  }

  return {
    async allowed(url) {
      const rules = await rulesFor(url.origin);
      return isPathAllowed(rules, `${url.pathname}${url.search}`);
    },
  };
}
