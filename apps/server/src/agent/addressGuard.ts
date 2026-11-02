import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// エージェントに読みに行かせる URL の名前を解決し、内側のネットワークを指していないか確かめる。
// checkPublicWebUrl（agent-kit）は名前の文字列しか見ないので、169.254.169.254.nip.io のように
// 公開の名前で内側のアドレスを指すものが通ってしまう。ここで解決した先のアドレスを見て止める。
// 確かめたあとに名前の向き先を変えられる（DNS リバインディング）ことまでは防げないので、
// 実行環境の外への通信の制限と組み合わせる（docs/spec/operations.md）。

/** 内側・ループバック・リンクローカルなど、外の Web ではないアドレスの範囲 */
const INTERNAL = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // この端末
  ["10.0.0.0", 8], // プライベート
  ["100.64.0.0", 10], // キャリアグレード NAT
  ["127.0.0.0", 8], // ループバック
  ["169.254.0.0", 16], // リンクローカル（クラウドのメタデータを含む）
  ["172.16.0.0", 12], // プライベート
  ["192.0.0.0", 24], // IETF の割り当て
  ["192.0.2.0", 24], // 文書用
  ["192.88.99.0", 24], // 6to4 の中継
  ["192.168.0.0", 16], // プライベート
  ["198.18.0.0", 15], // 機器の試験用
  ["198.51.100.0", 24], // 文書用
  ["203.0.113.0", 24], // 文書用
  ["224.0.0.0", 4], // マルチキャスト
  ["240.0.0.0", 4], // 予約・ブロードキャスト
] as const) {
  INTERNAL.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // 未指定
  ["::1", 128], // ループバック
  ["100::", 64], // 破棄用
  ["2001:db8::", 32], // 文書用
  ["fc00::", 7], // ユニークローカル
  ["fe80::", 10], // リンクローカル
  ["fec0::", 10], // サイトローカル（廃止）
  ["ff00::", 8], // マルチキャスト
] as const) {
  INTERNAL.addSubnet(network, prefix, "ipv6");
}

/** IPv6 を8つの16ビットの数に広げる。読めなければ null */
function expandIpv6(address: string): number[] | null {
  let text = address.split("%")[0] ?? "";
  // 末尾が IPv4 の書き方（::ffff:1.2.3.4）なら、16ビット2つに直す
  const v4 = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const words = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  const numbers = words.map((w) => Number.parseInt(w, 16));
  return numbers.length === 8 && numbers.every((n) => n >= 0 && n <= 0xffff) ? numbers : null;
}

/** IPv6 の中に入れた IPv4（::ffff:a.b.c.d と、NAT64 の 64:ff9b::/96）を取り出す */
function embeddedIpv4(words: number[]): string | null {
  const isMapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
  const isNat64 =
    words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0);
  if (!isMapped && !isNat64) return null;
  const [high = 0, low = 0] = words.slice(6);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** 外の Web ではないアドレスか。読めないアドレスも内側として扱う */
export function isInternalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return INTERNAL.check(address, "ipv4");
  if (family !== 6) return true;
  const words = expandIpv6(address);
  if (words === null) return true;
  const v4 = embeddedIpv4(words);
  return v4 === null ? INTERNAL.check(address, "ipv6") : INTERNAL.check(v4, "ipv4");
}

/** 名前を解決して、すべてのアドレスを返す */
export type ResolveHost = (host: string) => Promise<string[]>;

export const resolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

const RESOLVE_TIMEOUT_MS = 3_000;

/** 名前の向き先が外の Web だけか。解決できない名前や時間切れも断る */
export async function checkHostAddresses(
  host: string,
  resolve: ResolveHost = resolveHost,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let addresses: string[];
  try {
    addresses = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), RESOLVE_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch {
    return { ok: false, reason: "名前を解決できません" };
  }
  if (addresses.length === 0) return { ok: false, reason: "名前を解決できません" };
  if (addresses.some(isInternalAddress)) {
    return { ok: false, reason: "内側のネットワークを指す名前です" };
  }
  return { ok: true };
}
