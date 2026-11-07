import type Anthropic from "@anthropic-ai/sdk";
import { fictionalPatrolRequest } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it, vi } from "vitest";
import { createManagedPatrolAgent } from "./agent";
import { PATROL_NAMES } from "./config";

// 見回り係のセッションを作り、読み、消す。API には出ない。SDK の呼び出しの形だけを確かめる。

const patrolId = fictionalPatrolRequest().patrolId;

async function* listOf<T>(...items: T[]) {
  yield* items;
}

interface FakeOptions {
  session?: Record<string, unknown>;
  events?: unknown[];
}

function fakeClient({ session = {}, events = [] }: FakeOptions = {}) {
  const create = vi.fn(async (_params: unknown, _options?: unknown) => ({ id: "sesn_1" }));
  const send = vi.fn(async (_id: string, _params: unknown) => ({}));
  const remove = vi.fn(async (_id: string) => ({}));
  const retrieve = vi.fn(
    async (_id: string): Promise<Record<string, unknown>> => ({
      status: "idle",
      metadata: { patrol_id: patrolId },
      usage: { list_cost: { amount: "37", currency: "USD" } },
      ...session,
    }),
  );
  const client = {
    beta: {
      agents: {
        list: () =>
          listOf(
            { id: "agent_old", name: PATROL_NAMES.agent, archived_at: "2026-01-01T00:00:00Z" },
            { id: "agent_other", name: "matsuri-research-reader", archived_at: null },
            { id: "agent_1", name: PATROL_NAMES.agent, archived_at: null },
          ),
      },
      environments: {
        list: () => listOf({ id: "env_1", name: PATROL_NAMES.environment, archived_at: null }),
      },
      sessions: {
        create,
        retrieve,
        delete: remove,
        events: { list: () => listOf(...events), send },
      },
    },
  };
  return { client: client as unknown as Anthropic, create, send, remove, retrieve };
}

const notFound = () => Object.assign(new Error("見つかりません"), { status: 404 });

const idle = (stopReason: Record<string, unknown>) => ({
  type: "session.status_idle",
  stop_reason: stopReason,
});
const message = (text: string) => ({
  type: "agent.message",
  content: [{ type: "text", text }],
});
const fetchTool = (url: string, permission: string) => ({
  type: "agent.tool_use",
  name: "web_fetch",
  input: { url },
  evaluated_permission: permission,
});

describe("start", () => {
  it("予算つきのセッションを作り、URL を開始の発言に入れる", async () => {
    const { client, create } = fakeClient();
    const request = fictionalPatrolRequest();

    const sessionId = await createManagedPatrolAgent(client).start(request, 200);

    expect(sessionId).toBe("sesn_1");
    const params = create.mock.calls[0]?.[0] as Record<string, never>;
    expect(params).toMatchObject({
      agent: "agent_1",
      environment_id: "env_1",
      title: patrolId,
      budget: { type: "limit", max_list_cost: { amount: "200", currency: "USD" } },
      metadata: { patrol_id: patrolId },
    });
    // 秘密の値やファイルを付けない
    expect(params).not.toHaveProperty("vault_ids");
    expect(params).not.toHaveProperty("resources");
    expect(JSON.stringify(params.initial_events)).toContain(request.targets[0]?.pages[0]?.url);
  });

  it("セッションと費用が増えないよう、SDK の再試行を使わない", async () => {
    const { client, create } = fakeClient();

    await createManagedPatrolAgent(client).start(fictionalPatrolRequest(), 200);

    expect(create.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 });
  });

  it("定義がなければ失敗する", async () => {
    const { client } = fakeClient();
    (client.beta.environments as unknown as { list: unknown }).list = () => listOf();

    await expect(
      createManagedPatrolAgent(client).start(fictionalPatrolRequest(), 200),
    ).rejects.toThrow("見回りの定義がありません");
  });
});

describe("read", () => {
  it("見回り係のセッションでなければ、ID を返さない", async () => {
    const { client } = fakeClient({ session: { metadata: {} } });

    expect(await createManagedPatrolAgent(client).read("sesn_1")).toEqual({
      state: "running",
      patrolId: null,
    });
  });

  it("別のワークスペースのセッションや消したセッションは、見回りのものとして扱わない", async () => {
    const { client, retrieve } = fakeClient();
    retrieve.mockRejectedValue(notFound());

    expect(await createManagedPatrolAgent(client).read("sesn_1")).toEqual({
      state: "running",
      patrolId: null,
    });
  });

  it("ほかの失敗は投げる（再送と定期の起動で受け取り直す）", async () => {
    const { client, retrieve } = fakeClient();
    retrieve.mockRejectedValue(Object.assign(new Error("混み合っています"), { status: 529 }));

    await expect(createManagedPatrolAgent(client).read("sesn_1")).rejects.toThrow();
  });

  it.each(["running", "rescheduling"])("%s の間は動いている途中として返す", async (status) => {
    const { client } = fakeClient({ session: { status } });

    expect(await createManagedPatrolAgent(client).read("sesn_1")).toEqual({
      state: "running",
      patrolId,
    });
  });

  it("終わったら最後の返答と、実際に開いたページだけを返す", async () => {
    const { client } = fakeClient({
      events: [
        message("読みます"),
        fetchTool("https://example.com/allowed", "allow"),
        fetchTool("https://example.com/denied", "deny"),
        fetchTool("https://example.com/asked", "ask"),
        {
          type: "agent.tool_use",
          name: "web_search",
          input: { query: "x" },
          evaluated_permission: "allow",
        },
        message('{"報告":1}'),
        idle({ type: "end_turn" }),
      ],
    });

    expect(await createManagedPatrolAgent(client).read("sesn_1")).toEqual({
      state: "finished",
      patrolId,
      text: '{"報告":1}',
      fetchedUrls: ["https://example.com/allowed"],
      costCents: 37,
    });
  });

  it("確認待ちなら、断る呼び出しの ID を返す", async () => {
    const { client } = fakeClient({
      events: [idle({ type: "requires_action", event_ids: ["evt_1", "evt_2"] })],
    });

    expect(await createManagedPatrolAgent(client).read("sesn_1")).toEqual({
      state: "waiting",
      patrolId,
      toolUseIds: ["evt_1", "evt_2"],
    });
  });

  it.each([
    ["budget_reached", "budget"],
    ["refusal", "refused"],
    ["retries_exhausted", "retries"],
  ])("%s で止まったら失敗の分類を返す", async (type, reason) => {
    const { client } = fakeClient({ events: [idle({ type })] });

    expect(await createManagedPatrolAgent(client).read("sesn_1")).toEqual({
      state: "failed",
      patrolId,
      reason,
      costCents: 37,
    });
  });

  it("idle の記録がまだなければ、動いている途中として扱う", async () => {
    const { client } = fakeClient({ events: [] });

    expect((await createManagedPatrolAgent(client).read("sesn_1")).state).toBe("running");
  });

  it("終わったセッションは、返答があれば結果を受け取る", async () => {
    const { client } = fakeClient({
      session: { status: "terminated" },
      events: [message("{}")],
    });

    expect(await createManagedPatrolAgent(client).read("sesn_1")).toMatchObject({
      state: "finished",
      text: "{}",
    });
  });
});

describe("deny", () => {
  it("確認待ちの呼び出しをすべて断る", async () => {
    const { client, send } = fakeClient();

    await createManagedPatrolAgent(client).deny("sesn_1", ["evt_1", "evt_2"]);

    expect(send).toHaveBeenCalledWith("sesn_1", {
      events: [
        { type: "user.tool_confirmation", tool_use_id: "evt_1", result: "deny" },
        { type: "user.tool_confirmation", tool_use_id: "evt_2", result: "deny" },
      ],
    });
  });
});

describe("dispose", () => {
  it("止まっているセッションは消す", async () => {
    const { client, remove, send } = fakeClient();

    expect(await createManagedPatrolAgent(client).dispose("sesn_1")).toBe(true);

    expect(remove).toHaveBeenCalledWith("sesn_1");
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["running", "rescheduling"])(
    "%s のセッションは止める指示を送り、あとで消す",
    async (status) => {
      const { client, remove, send } = fakeClient({ session: { status } });

      expect(await createManagedPatrolAgent(client).dispose("sesn_1")).toBe(false);

      expect(send).toHaveBeenCalledWith("sesn_1", { events: [{ type: "user.interrupt" }] });
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it("もうないセッションは、消せたものとして扱う", async () => {
    const { client, retrieve } = fakeClient();
    retrieve.mockRejectedValue(notFound());

    expect(await createManagedPatrolAgent(client).dispose("sesn_1")).toBe(true);
  });

  it("ほかの失敗は投げる", async () => {
    const { client, remove } = fakeClient();
    remove.mockRejectedValue(Object.assign(new Error("動いている途中です"), { status: 400 }));

    await expect(createManagedPatrolAgent(client).dispose("sesn_1")).rejects.toThrow();
  });
});
