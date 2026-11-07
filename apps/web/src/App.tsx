import { useEffect } from "react";
import { useRestartWhenUserLeaves } from "./account/useAccountUser";
import { useApp } from "./state/react";
import { AccountWatch } from "./ui/AccountWatch";
import { ShioriPage } from "./ui/ShioriPage";
import { Shop } from "./ui/Shop";
import { Storefront } from "./ui/Storefront";
import { Street } from "./ui/Street";
import { useBackgroundMusic, useSoundEffects } from "./ui/sound";
import { Celebration } from "./ui/Waiting";

export function App() {
  const view = useApp((state) => state.ui.view);
  const locale = useApp((state) => state.ui.locale);
  useSoundEffects();
  useBackgroundMusic();
  useRestartWhenUserLeaves();

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <>
      {view === "storefront" ? <Storefront /> : null}
      {view === "shop" ? <Shop /> : null}
      {view === "shiori" ? <ShioriPage /> : null}
      {view === "street" ? <Street /> : null}
      <Celebration />
      <AccountWatch />
    </>
  );
}
