import { Component, type ReactNode } from "react";
import { useT } from "../state/react";
import { buttonPrimary } from "./common";

// 部品の描画の例外を受け止める。受け止めるものがないと、React は画面をすべて外し、無地の背景だけが残る。
// 例えば、開いているページのあとに新しい版が公開されると、遅れて読み込む部品のファイルが取れなくなり、
// 読み込みの失敗が描画の例外として届く。

export class ErrorBoundary extends Component<{
  /** ログに出す部品の名前 */
  name: string;
  fallback: ReactNode;
  children: ReactNode;
}> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.warn(`[${this.props.name}] 描画できなかったので、代わりの表示にします`, error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** ページを読み込み直すボタン */
export function ReloadButton({ className = "" }: { className?: string }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`${buttonPrimary} text-base ${className}`}
      onClick={() => window.location.reload()}
    >
      {t.app.reload}
    </button>
  );
}

/** 画面の全体を描けなかったときの表示。無地のままにせず、読み込み直せるようにする */
export function PageTrouble() {
  const t = useT();
  return (
    <main className="grid min-h-dvh place-items-center p-4 text-ink" data-testid="page-trouble">
      <div className="washi max-w-md rounded-panel border-2 border-wood-700/50 p-6 text-center shadow-lift">
        <h1 className="font-bold text-ai-800 text-xl">{t.app.troubleTitle}</h1>
        <p className="mt-2 text-base leading-relaxed">{t.app.troubleBody}</p>
        <ReloadButton className="mt-4" />
      </div>
    </main>
  );
}
