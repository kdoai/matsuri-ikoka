// 調べ役が読むページの robots.txt を確かめる。サイトが読まないでほしいと書いているページは読まない。
// robots.txt がない・読めないときは、読んでよいとして扱う（調べを止めない）。
// 問い合わせはサイトごとに1回だけにし、転送はたどらない（宛先の確認を通っていない先へ行かないため）。

export const ROBOTS_USER_AGENT = "matsuri-ikoka";
/** robots.txt の問い合わせを打ち切る時間（ミリ秒） */
const ROBOTS_TIMEOUT_MS = 3_000;
/** とっておく時間 */
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 読む robots.txt の大きさの上限（バイト）。超えた分は読まない */
const MAX_ROBOTS_BYTES = 200_000;
/** 1つの組から読む決まりの数の上限。超えた分は使わない */
const MAX_ROBOTS_RULES = 1_000;
/** 1つの決まりの長さの上限（文字）。超えた決まりは使わない */
const MAX_RULE_LENGTH = 500;

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
      if (value === "" || value.length > MAX_RULE_LENGTH) continue;
      const rule = { allow: key === "allow", path: value };
      if (agents.includes(agent.toLowerCase()) && named.length < MAX_ROBOTS_RULES) named.push(rule);
      if (agents.includes("*") && wildcard.length < MAX_ROBOTS_RULES) wildcard.push(rule);
    }
  }
  return named.length > 0 ? named : wildcard;
}

/**
 * * と $ を含む決まりの道筋が、URL の道筋に当たるか。
 * サイトが書いた文字列なので、正規表現にしない（* が並ぶと戻りが爆発し、同期の処理なのでサーバーごと止まる）。
 * * で分けた断片を、前から順に1度だけ探す。末尾の $ は「ここで終わる」の印で、ほかの $ はただの文字
 */
function matches(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith("$");
  const parts = (anchored ? rulePath.slice(0, -1) : rulePath).split("*");
  const head = parts[0] ?? "";
  if (!path.startsWith(head)) return false;
  if (parts.length === 1) return !anchored || path === head;
  const tail = parts.at(-1) ?? "";
  let at = head.length;
  for (const part of parts.slice(1, -1)) {
    if (part === "") continue;
    const found = path.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  if (anchored) return path.length - tail.length >= at && path.endsWith(tail);
  return path.indexOf(tail, at) >= 0;
}

/** 本文を上限のバイト数まで読む。届いた分を全部読んでから切ると、大きな本文でメモリと時間を使うので、途中でやめる */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const part = value.subarray(0, maxBytes - total);
    total += part.byteLength;
    text += decoder.decode(part, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text + decoder.decode();
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
        rules = parseRobots(await readLimitedText(response, MAX_ROBOTS_BYTES));
      } else {
        // 読まない本文を放っておくと、接続が閉じられたときに通信のライブラリが例外を投げることがある
        await response.body?.cancel().catch(() => {});
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
