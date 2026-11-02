import type { TransportKind } from "../state/types";

// 相談の通信先を決める。開発では画面だけのモックを既定にし、接客サーバーへも切り替えられる。
//   ?transport=mock|server  通信先（モックが使えるビルドのときだけ）
//   ?sample=<id>            再生する記録（data/samples/conversations の名前）
//   ?speed=<倍率>            モックの再生の速さ

export interface TransportEnv {
  /** モックを含めたビルドか（開発のとき、または VITE_ENABLE_MOCK=true） */
  mockEnabled: boolean;
  /** 既定の通信先（VITE_TRANSPORT）。なければ、モックが使えるときはモック */
  defaultTransport: string | undefined;
}

export interface TransportChoice {
  kind: TransportKind;
  sampleId: string | null;
  speed: number;
}

const MIN_SPEED = 0.25;
const MAX_SPEED = 20;

function asKind(value: string | null | undefined): TransportKind | null {
  return value === "mock" || value === "server" ? value : null;
}

export function resolveTransport(search: string, env: TransportEnv): TransportChoice {
  const params = new URLSearchParams(search);
  const requested = asKind(params.get("transport")) ?? asKind(env.defaultTransport);
  const kind: TransportKind = env.mockEnabled ? (requested ?? "mock") : "server";
  const speed = Number(params.get("speed"));
  return {
    kind,
    sampleId: params.get("sample"),
    speed:
      Number.isFinite(speed) && speed > 0 ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) : 1,
  };
}
