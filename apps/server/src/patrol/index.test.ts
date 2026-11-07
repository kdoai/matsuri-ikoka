import { deleteApp, getApp } from "firebase-admin/app";
import { describe, expect, it } from "vitest";
import { createAccount, readAccountConfig } from "../account/firebase";
import { createFestivalStore } from "../data/festivalStore";
import { createUnavailableLodging } from "../tools/lodging";
import { FirestorePatrolStore } from "./firestoreStore";
import { createPatrolDeps } from "./index";
import { MemoryPatrolStore } from "./store";

// 見回りの部品の組み立て。API には出ない。鍵の値はテストのためだけのもの。

const input = {
  festivals: createFestivalStore([]),
  lodging: createUnavailableLodging(),
};

describe("createPatrolDeps", () => {
  it("設定がなければ用意しない。見回りの入口だけが断り、サーバーは起動する", async () => {
    expect(await createPatrolDeps({ ...input, env: {} })).toBeNull();
  });

  it("鍵があれば、部品をそろえる", async () => {
    const deps = await createPatrolDeps({
      ...input,
      env: { PATROL_ANTHROPIC_API_KEY: "test-only-not-a-real-key" },
    });

    expect(deps?.store).toBeInstanceOf(MemoryPatrolStore);
    expect(deps?.config.sessionBudgetCents).toBe(200);
    expect(deps?.agent).toBeDefined();
  });

  it("保存先が Firestore なら、旅の保存と同じアプリの Firestore を使う", async () => {
    const env = {
      MATSURI_STORAGE: "firestore",
      FIREBASE_PROJECT_ID: "demo-matsuri-ikoka",
      PATROL_ANTHROPIC_API_KEY: "test-only-not-a-real-key",
    };
    await createAccount(readAccountConfig(env));

    const deps = await createPatrolDeps({ ...input, env });

    expect(deps?.store).toBeInstanceOf(FirestorePatrolStore);
    await deleteApp(getApp());
    // Admin SDK の読み込みに時間がかかる
  }, 60_000);
});
