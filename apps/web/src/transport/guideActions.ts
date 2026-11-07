import {
  DecideProposalResponseSchema,
  MarkNoticesReadResponseSchema,
  TripChangeSchema,
  TripWatchSchema,
} from "@matsuri-ikoka/schema";
import type { z } from "zod";
import { createPasscodeHolder, PASSCODE_HEADER, type PasscodeHolder } from "./server";
import type { ChatTransport } from "./types";
import { errorFromResponse, TransportError } from "./types";

// ガイドの決める操作（既読・見回りの開始と停止・提案の承認と却下・前の版に戻す）の通信。
// 接客サーバーの通信の口（server.ts）に、同じヘッダー（合言葉と ID トークン）で足す。
// 応答はスキーマで確かめてから返す。

export interface GuideActionsOptions {
  passcode?: PasscodeHolder;
  fetch?: typeof fetch;
  /** ログインしていれば ID トークンを返す。していなければ null。ログイン中に取れなければ例外 */
  idToken?: () => Promise<string | null>;
}

export function withGuideActions(
  transport: ChatTransport,
  options: GuideActionsOptions = {},
): ChatTransport {
  const passcode = options.passcode ?? createPasscodeHolder();
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  /** ログイン中にトークンを取れなければ送らない（ログインなしとして送ると、自分の相談が 404 になる） */
  const headers = async (): Promise<Record<string, string>> => {
    let token: string | null;
    try {
      token = (await options.idToken?.()) ?? null;
    } catch (error) {
      throw error instanceof TransportError ? error : new TransportError("connection_lost");
    }
    const value = passcode.get();
    return {
      "Content-Type": "application/json",
      ...(value === null ? {} : { [PASSCODE_HEADER]: value }),
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    };
  };

  const post = async <T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> => {
    const response = await fetchImpl(path, {
      method: "POST",
      headers: await headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // 404 は、ない提案・ない通知・もう話せない相談。呼ぶ側が状態コードで見分ける
      throw await errorFromResponse(response, false);
    }
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new TransportError("invalid_event", { status: response.status });
    }
    return parsed.data;
  };

  return {
    ...transport,
    markNoticesRead: (request) =>
      post("/api/guide/notices/read", request, MarkNoticesReadResponseSchema),
    setTripWatch: (request) => post("/api/guide/watch", request, TripWatchSchema),
    decideProposal: (proposalId, request) =>
      post(
        `/api/guide/proposals/${encodeURIComponent(proposalId)}/decision`,
        request,
        DecideProposalResponseSchema,
      ),
    revertTrip: (request) => post("/api/guide/revert", request, TripChangeSchema),
  };
}
