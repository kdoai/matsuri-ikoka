import { useT } from "../state/react";

// 3D を描けないとき（WebGL がない・3D の読み込みに失敗した）の知らせ。2D の店や通りには切り替えない。
// 会話の窓・屋台の窓・しおりは 3D と別の部品なので、相談はこのまま続けられる。

export function No3dNotice({ className = "" }: { className?: string }) {
  const t = useT();
  return (
    <p
      role="status"
      className={`max-w-md rounded-2xl bg-ink/80 px-5 py-3 text-center font-bold text-kinari-50 leading-relaxed shadow-lg ${className}`}
      data-testid="no-3d"
    >
      {t.app.no3d}
    </p>
  );
}
