import { useEffect, useRef, useState } from "react";
import { useActions, useApp, useT } from "../state/react";
import { shioriReady } from "../state/selectors";
import { buttonPrimary, buttonSecondary } from "./common";
import { shioriShareUrl } from "./links";

// 旅のしおり。サーバーが作る冊子のしおり（GET /shiori/:id。PDF と同じ A4 の紙）を、そのまま埋め込んで見せる。
// しおりの中は見開きで2ページずつ並び、左右の矢印でめくる。印刷と PDF も同じ紙になる。

/** しおりの URL と、コピーのボタン */
function ShareBox({ url }: { url: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 text-kinari-50 text-sm"
      data-testid="shiori-share"
    >
      <span className="font-bold max-sm:sr-only">{t.shiori.share}</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 break-all font-medium underline underline-offset-2 max-sm:sr-only"
        title={t.shiori.shareNote}
      >
        {url}
      </a>
      <button type="button" className={buttonSecondary} onClick={() => void copy()}>
        {copied ? t.shiori.copied : t.shiori.copy}
      </button>
    </div>
  );
}

export function ShioriPage() {
  const t = useT();
  const actions = useActions();
  const itinerary = useApp((state) => state.itinerary.current);
  const ready = useApp(shioriReady);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  if (itinerary === null) {
    return null;
  }
  const shareUrl = ready ? shioriShareUrl(itinerary.id, window.location.origin) : null;

  return (
    <div className="flex h-dvh flex-col bg-wood-800" data-testid="shiori">
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <button
          type="button"
          className={`${buttonSecondary} bg-kinari-50`}
          onClick={actions.closeShiori}
        >
          {t.shiori.close}
        </button>
        <h1
          id="shiori-title"
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate font-bold text-kinari-50 text-lg max-sm:sr-only"
        >
          {itinerary.title}
        </h1>
        {shareUrl === null ? null : (
          <div className="flex flex-wrap gap-2">
            {/* 埋め込んだしおり（同じオリジン）を印刷する。しおりの側にはスクリプトがない */}
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => frameRef.current?.contentWindow?.print()}
            >
              {t.shiori.print}
            </button>
            <a
              href={`${shareUrl}.pdf`}
              download
              className={`${buttonPrimary} inline-flex items-center`}
              data-testid="shiori-pdf"
            >
              {t.shiori.savePdf}
            </a>
          </div>
        )}
        {shareUrl === null ? null : <ShareBox url={shareUrl} />}
      </div>
      {shareUrl === null ? (
        <p className="m-4 rounded-xl bg-kinari-50 p-4 text-ink">{t.shiori.notReady}</p>
      ) : (
        <iframe
          ref={frameRef}
          src={`${shareUrl}?embed=1`}
          title={t.shiori.booklet}
          className="min-h-0 w-full flex-1 border-0"
          data-testid="shiori-booklet"
        />
      )}
    </div>
  );
}
