// お試し用のアカウントを作る・初期の状態に戻す・パスワードを作り直す（docs/spec/account.md）。人が手元で実行する。
//
//   pnpm --filter @matsuri-ikoka/server trial:account create            # 作る。パスワードを画面に出す
//   pnpm --filter @matsuri-ikoka/server trial:account reset             # 残した旅などを消し、初期の状態に戻す
//   pnpm --filter @matsuri-ikoka/server trial:account rotate-password   # パスワードを作り直して画面に出す
//
// 値は環境変数で渡す：FIREBASE_PROJECT_ID・TRIAL_ACCOUNT_EMAIL（create と reset）・FIRESTORE_DATABASE_ID（省略可）。
// 権限は gcloud auth application-default login の資格情報を使う。鍵のファイルは使わない。
// パスワードはこの端末の画面にだけ出す。ファイルにもログにも書かない。CI では動かさない。

import { TRIAL_ACCOUNT_UID } from "@matsuri-ikoka/schema";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import {
  createTrialAccount,
  resetTrialAccount,
  rotateTrialPassword,
  TRIAL_STATE_DOC,
  TrialAccountError,
  type TrialState,
} from "../src/account/trialAccount";
import { FirestoreTripStorage } from "../src/storage/firestore";
import { ownerIdOf } from "../src/storage/owner";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TrialAccountError(`環境変数 ${name} を渡してください`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (process.env.CI) throw new TrialAccountError("CI では実行しません（パスワードがログに残る）");
  if (command !== "create" && command !== "reset" && command !== "rotate-password") {
    throw new TrialAccountError("使い方: trial:account create|reset|rotate-password");
  }

  const app = initializeApp({ projectId: required("FIREBASE_PROJECT_ID") });
  const auth = getAuth(app);
  const databaseId = process.env.FIRESTORE_DATABASE_ID?.trim();
  const db = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
  const state: TrialState = {
    invalidateLogins: async (validAfter) => {
      await db.doc(TRIAL_STATE_DOC).set({ validAfter });
    },
  };

  if (command === "create") {
    const password = await createTrialAccount(auth, required("TRIAL_ACCOUNT_EMAIL"));
    console.log(`作りました。パスワード（再表示はできません）：${password}`);
  } else if (command === "rotate-password") {
    const password = await rotateTrialPassword(auth, state);
    console.log(`作り直しました。パスワード（再表示はできません）：${password}`);
  } else {
    // 人が権限を持って実行するスクリプトなので、確かめた ID トークンなしで持ち主を決める（storage/owner.ts の例外）
    const trips = new FirestoreTripStorage(db).forOwner(ownerIdOf(TRIAL_ACCOUNT_UID));
    const email = required("TRIAL_ACCOUNT_EMAIL");
    const { deleted, hasPassword } = await resetTrialAccount(auth, trips, state, email);
    console.log(
      `残した旅 ${deleted} 件を消し、ログインと結びつけたものを外しました。パスワードは変えていません。`,
    );
    if (!hasPassword) {
      console.log("パスワードが外されています。rotate-password で作り直してください。");
    }
  }
}

main().catch((error: unknown) => {
  // 例外の文に入力が入ることがあるので、自分で書いた文のほかは種類だけを出す
  const known = error instanceof TrialAccountError;
  const code = (error as { code?: unknown }).code;
  console.error(known ? (error as Error).message : `失敗しました（${String(code ?? "不明")}）`);
  process.exit(1);
});
