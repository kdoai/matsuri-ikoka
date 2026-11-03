import { createContext, type ReactNode, useContext } from "react";
import type { AccountClient } from "./client";

// ログインと自分の旅の通信の口を、部品に渡す。null ならログインを出さない（部品だけを試すとき）。

const AccountContext = createContext<AccountClient | null>(null);

export function AccountProvider({
  client,
  children,
}: {
  client: AccountClient | null;
  children: ReactNode;
}) {
  return <AccountContext.Provider value={client}>{children}</AccountContext.Provider>;
}

export function useAccountClient(): AccountClient | null {
  return useContext(AccountContext);
}
