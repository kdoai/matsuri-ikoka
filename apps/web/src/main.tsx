import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { detectLocale } from "./i18n";
import { StoreProvider } from "./state/react";
import { createAppStore } from "./state/store";
import { resolveTransport } from "./transport/mode";
import { createServerFestivalSource, createServerTransport } from "./transport/server";
import type { ChatTransport, FestivalSource } from "./transport/types";
import "./index.css";

// 開発のとき（または VITE_ENABLE_MOCK=true でビルドしたとき）だけ、画面だけのモックを含める
const mockEnabled = import.meta.env.DEV || import.meta.env.VITE_ENABLE_MOCK === "true";

async function connect(): Promise<{ transport: ChatTransport; festivals: FestivalSource }> {
  const choice = resolveTransport(window.location.search, {
    mockEnabled,
    defaultTransport: import.meta.env.VITE_TRANSPORT,
  });
  if (mockEnabled && choice.kind === "mock") {
    const [{ createMockTransport }, { createSampleFestivalSource, loadSample }] = await Promise.all(
      [import("./mock/replay"), import("./mock/samples")],
    );
    const sample = await loadSample(choice.sampleId);
    return {
      transport: createMockTransport(sample, { speed: choice.speed }),
      festivals: createSampleFestivalSource(),
    };
  }
  return { transport: createServerTransport(), festivals: createServerFestivalSource() };
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root が見つかりません");
}

void connect().then(({ transport, festivals }) => {
  const store = createAppStore({ transport, festivals, locale: detectLocale(navigator.languages) });
  createRoot(root).render(
    <StrictMode>
      <StoreProvider store={store}>
        <App mockEnabled={mockEnabled} />
      </StoreProvider>
    </StrictMode>,
  );
});
