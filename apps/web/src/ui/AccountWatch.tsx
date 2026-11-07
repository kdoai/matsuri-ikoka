import { useEffect, useRef } from "react";
import type { AccountUser } from "../account/client";
import { useAccountClient } from "../account/context";
import { useAppStore } from "../state/react";
import type { AppStore } from "../state/store";

// ログインしていた人が離れたら、通りに残った前の人の旅・通知・会話を消す。
// ログインの状態を読むだけで、ログインの処理はしない。何度呼ばれても害がない（restart を重ねるだけ）。

/** 前にログインしていた人が離れたか。ログインなしからログインしたときは、相談を続ける */
export function userLeft(before: AccountUser | null, after: AccountUser | null): boolean {
  return before !== null && (after === null || after.name !== before.name);
}

/** 通りに出たことがある相談なら、新しい相談から始める */
export function clearGuideForLeavingUser(store: AppStore): void {
  const { guide, actions } = store.getState();
  if (guide.availability !== "idle") void actions.restart();
}

export function AccountWatch() {
  const client = useAccountClient();
  const store = useAppStore();
  const before = useRef<AccountUser | null>(null);
  useEffect(() => {
    if (client === null) return;
    return client.onUser((user) => {
      if (userLeft(before.current, user)) clearGuideForLeavingUser(store);
      before.current = user;
    });
  }, [client, store]);
  return null;
}
