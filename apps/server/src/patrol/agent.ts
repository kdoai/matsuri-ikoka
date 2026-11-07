import type Anthropic from "@anthropic-ai/sdk";
import { createWebActivityLog } from "@matsuri-ikoka/agent-kit";
import type { PatrolRequest } from "@matsuri-ikoka/schema";
import { PATROL_NAMES } from "./config";
import { patrolStartMessage } from "./request";

// 見回り係（Managed Agents のセッション）を動かす口。定義は managed-agents/ のファイルにあり、ant apply で適用する。
// ここはセッションを作ることと、終わったセッションを読むことだけを行う。

export const PATROL_METADATA_KEY = "patrol_id";

export type PatrolFailureReason = "budget" | "refused" | "retries" | "unknown";

export type PatrolSessionState =
  | { state: "running"; patrolId: string | null }
  /** 確認待ちの呼び出しで止まっている。確かめる人はいないので断る */
  | { state: "waiting"; patrolId: string | null; toolUseIds: string[] }
  /** 終わった。最後の返答と、実際に開いたページを返す */
  | {
      state: "finished";
      patrolId: string | null;
      text: string | null;
      fetchedUrls: string[];
      costCents: number | null;
    }
  | {
      state: "failed";
      patrolId: string | null;
      reason: PatrolFailureReason;
      costCents: number | null;
    };

export interface PatrolAgent {
  /** セッションを作って見回りを始める。セッションの ID を返す */
  start(request: PatrolRequest, budgetCents: number): Promise<string>;
  read(sessionId: string): Promise<PatrolSessionState>;
  /** 確認待ちの呼び出しを断る */
  deny(sessionId: string, toolUseIds: readonly string[]): Promise<void>;
}

/** 名前で探す。ID は ant apply が管理するので、コードには持たない */
async function findByName<T extends { id: string; name: string; archived_at?: string | null }>(
  items: AsyncIterable<T>,
  name: string,
): Promise<T> {
  for await (const item of items) {
    if (item.name === name && !item.archived_at) return item;
  }
  throw new Error("見回りの定義がありません。managed-agents/ を適用してください");
}

function centsOf(amount: { amount: string } | null | undefined): number | null {
  const cents = Number(amount?.amount);
  return Number.isFinite(cents) ? cents : null;
}

export function createManagedPatrolAgent(client: Anthropic): PatrolAgent {
  return {
    async start(request, budgetCents) {
      const [agent, environment] = await Promise.all([
        findByName(client.beta.agents.list(), PATROL_NAMES.agent),
        findByName(client.beta.environments.list(), PATROL_NAMES.environment),
      ]);
      const session = await client.beta.sessions.create({
        agent: agent.id,
        environment_id: environment.id,
        title: request.patrolId,
        budget: {
          type: "limit",
          max_list_cost: { amount: String(budgetCents), currency: "USD" },
        },
        metadata: { [PATROL_METADATA_KEY]: request.patrolId },
        initial_events: [
          {
            type: "user.message",
            content: [{ type: "text", text: patrolStartMessage(request) }],
          },
        ],
      });
      return session.id;
    },

    async read(sessionId) {
      const session = await client.beta.sessions.retrieve(sessionId);
      const patrolId = session.metadata?.[PATROL_METADATA_KEY] ?? null;
      if (patrolId === null) return { state: "running", patrolId };
      if (session.status === "running" || session.status === "rescheduling") {
        return { state: "running", patrolId };
      }
      const costCents = centsOf(session.usage?.list_cost);

      const log = createWebActivityLog();
      let text: string | null = null;
      let stop: string | null = null;
      let waitingOn: string[] = [];
      for await (const event of client.beta.sessions.events.list(sessionId, { order: "asc" })) {
        if (event.type === "agent.message") {
          const body = event.content.flatMap((block) =>
            block.type === "text" ? [block.text] : [],
          );
          if (body.length > 0) text = body.join("");
        } else if (event.type === "agent.tool_use") {
          // 断られた呼び出しや確認待ちの呼び出しは、開いたページとして数えない
          if (event.name === "web_fetch" && event.evaluated_permission === "allow") {
            log.record("WebFetch", event.input);
          }
        } else if (event.type === "session.status_idle") {
          stop = event.stop_reason.type;
          waitingOn =
            event.stop_reason.type === "requires_action" ? event.stop_reason.event_ids : [];
        }
      }
      if (session.status === "idle" && stop === null) return { state: "running", patrolId };
      if (session.status === "idle" && stop === "requires_action") {
        return { state: "waiting", patrolId, toolUseIds: waitingOn };
      }
      if (session.status === "terminated" || stop === "end_turn") {
        return {
          state: "finished",
          patrolId,
          text,
          fetchedUrls: [...log.fetchedUrls],
          costCents,
        };
      }
      const reason: PatrolFailureReason =
        stop === "budget_reached"
          ? "budget"
          : stop === "refusal"
            ? "refused"
            : stop === "retries_exhausted"
              ? "retries"
              : "unknown";
      return { state: "failed", patrolId, reason, costCents };
    },

    async deny(sessionId, toolUseIds) {
      await client.beta.sessions.events.send(sessionId, {
        events: toolUseIds.map((id) => ({
          type: "user.tool_confirmation" as const,
          tool_use_id: id,
          result: "deny" as const,
        })),
      });
    },
  };
}
