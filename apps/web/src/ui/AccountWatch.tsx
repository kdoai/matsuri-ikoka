import { useEffect, useRef } from "react";
import { watchUserLeaving } from "../account/client";
import { useAccountUser } from "../account/useAccountUser";
import { useAppStore } from "../state/react";
import type { AppStore } from "../state/store";

// ログインしていた人が離れたときの片付けのうち、useRestartWhenUserLeaves が見ない場合だけを受け持つ。
// ガイドのない環境で残した旅を開くと、相談の ID はないが、旅程は手元にある。
// 相談の ID があるときは useRestartWhenUserLeaves が新しい相談を始めるので、ここでは何もしない。

/** 相談の ID がなく、前の人の旅が手元にあれば、消して新しい相談から始める */
export function clearTripWithoutSession(store: AppStore): void {
  const { session, itinerary, actions } = store.getState();
  if (session.id === null && itinerary.current !== null) void actions.restart();
}

export function AccountWatch() {
  const { user } = useAccountUser();
  const store = useAppStore();
  const onUser = useRef(watchUserLeaving(() => clearTripWithoutSession(store)));
  useEffect(() => {
    onUser.current(user);
  }, [user]);
  return null;
}
