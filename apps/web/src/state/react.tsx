import { createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { MESSAGES, type Messages } from "../i18n";
import type { AppActions, AppState, AppStore } from "./store";

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error("StoreProvider の内側で使ってください");
  }
  return store;
}

/** ストアの一部を読む。オブジェクトを返すときは浅い比較で、変わったときだけ描き直す */
export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(useAppStore(), useShallow(selector));
}

export function useActions(): AppActions {
  return useStore(useAppStore(), (state) => state.actions);
}

/** いまの言語の文言 */
export function useT(): Messages {
  return MESSAGES[useStore(useAppStore(), (state) => state.ui.locale)];
}
