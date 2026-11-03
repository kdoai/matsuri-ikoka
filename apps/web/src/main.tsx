// いちばん先に読み込む（スキーマのモジュールより前に zod を設定する）
import "./zod-setup";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { detectLocale } from "./i18n";
import { StoreProvider } from "./state/react";
import { createAppStore } from "./state/store";
import {
  createPasscodeHolder,
  createServerFestivalSource,
  createServerTransport,
} from "./transport/server";
// 丸ゴシックの字体（OFL）。使う文字の分だけ、必要になったときに読み込まれる
import "@fontsource/zen-maru-gothic/400.css";
import "@fontsource/zen-maru-gothic/700.css";
import "./index.css";

// 画面はいつも接客サーバーと話す。AI の部分を記録の再生にするときは、サーバーを
// MATSURI_AGENT_MODE=mock で動かし、?sample=<id> で再生する記録を選ぶ。
const sample = new URLSearchParams(window.location.search).get("sample");

// 合言葉は、相談の通信と祭りのデータの読み込みで共有する（メモリにだけ持つ）
const passcode = createPasscodeHolder();
const store = createAppStore({
  transport: createServerTransport({ passcode, sample }),
  festivals: createServerFestivalSource({ passcode }),
  locale: detectLocale(navigator.languages),
});

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root が見つかりません");
}

createRoot(root).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
