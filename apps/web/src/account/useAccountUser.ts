import { useEffect, useRef, useState } from "react";
import { useActions, useApp, useAppStore } from "../state/react";
import { type AccountUser, watchUserLeaving } from "./client";
import { useAccountClient } from "./context";

// ログインの状態を部品に渡す。ログインの状態を見る部品は、ここから受け取る。

export interface AccountUserState {
  /** ログインを用意しているか */
  enabled: boolean;
  user: AccountUser | null;
}

/**
 * ログインを用意しているかと、いまの利用者。
 * 合言葉が要るサーバーでは、合言葉を入れて相談が始まるまで設定を読めないので、そのあとに読み直す
 */
export function useAccountUser(): AccountUserState {
  const client = useAccountClient();
  const sessionReady = useApp((state) => state.session.id !== null);
  const [state, setState] = useState<AccountUserState>({ enabled: false, user: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionReady は読み直しのきっかけとして見る
  useEffect(() => {
    if (client === null) return;
    let active = true;
    void client.enabled().then((enabled) => {
      if (active) setState((current) => ({ ...current, enabled }));
    });
    const stop = client.onUser((user) => {
      if (active) setState((current) => ({ ...current, user }));
    });
    return () => {
      active = false;
      stop();
    };
  }, [client, sessionReady]);

  return state;
}

/**
 * ログインしていた人がいなくなったら（ログアウト・アカウントの削除・別のタブでのログアウト）、
 * 前の人の旅程と会話を残さず、新しい相談を始める。どの画面でも気づけるよう、App で呼ぶ。
 * まだ相談を始めていなければ、何もしない（店の外から店の中へ移らない）
 */
export function useRestartWhenUserLeaves(): void {
  const { user } = useAccountUser();
  const { restart } = useActions();
  const store = useAppStore();
  const onUser = useRef(
    watchUserLeaving(() => {
      if (store.getState().session.id !== null) void restart();
    }),
  );

  useEffect(() => {
    onUser.current(user);
  }, [user]);
}
