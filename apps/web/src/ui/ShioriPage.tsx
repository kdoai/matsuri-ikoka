import { useEffect, useRef, useState } from "react";
import { useAccountClient } from "../account/context";
import { useActions, useApp, useT } from "../state/react";
import { shioriReady } from "../state/selectors";
import { buttonPrimary, buttonSecondary } from "./common";
import { KeepTrip } from "./KeepTrip";
import { resolveShioriUrl } from "./links";
import { fetchShioriPdf, saveBlob } from "./pdfDownload";

// 旅のしおり。サーバーが作る冊子のしおり（GET /shiori/:id。PDF と同じ A4 の紙）を、そのまま埋め込んで見せる。
// しおりの中は見開きで2ページずつ並び、左右の矢印でめくる。印刷と PDF も同じ紙になる。

/** PDF の保存のボタン。取って確かめてから保存し、失敗したらその旨を出す */
function SavePdfButton({ url }: { url: string }) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "saving" | "busy" | "failed">("idle");
  const save = async () => {
    setStatus("saving");
    const result = await fetchShioriPdf(url);
    if (!result.ok) {
      setStatus(result.reason);
      return;
    }
    saveBlob(result.blob, result.filename);
    setStatus("idle");
  };
  return (
    <>
      <a
        href={url}
        download
        aria-disabled={status === "saving"}
        className={`${buttonPrimary} inline-flex items-center`}
        data-testid="shiori-pdf"
        onClick={(event) => {
          event.preventDefault();
          if (status !== "saving") void save();
        }}
      >
        {status === "saving" ? t.shiori.savingPdf : t.shiori.savePdf}
      </a>
      {status === "busy" || status === "failed" ? (
        <p
          role="alert"
          className="basis-full rounded-lg bg-kinari-50 px-3 py-1 text-ink text-sm"
          data-testid="shiori-pdf-error"
        >
          {status === "busy" ? t.shiori.pdfBusy : t.shiori.pdfFailed}
        </p>
      ) : null}
    </>
  );
}

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
  const shioriOpen = ready;
  const checkedAt = useApp((state) => state.verify.checkedAt);
  // しおりをまだ出せないときの案内のページを、画面と同じ言語で出してもらう
  const locale = useApp((state) => state.ui.locale);
  const account = useAccountClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [resolved, setResolved] = useState<{ key: string; url: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const itineraryId = itinerary?.id ?? null;
  // 版が同じでも、開催の確かめ直しで内容が変わるので、確かめた時刻もいっしょに見る
  const key = `${itineraryId}@${itinerary?.version}@${checkedAt}#${attempt}`;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // 自分の旅程は共有の ID で開く。ログインしていなければ、旅程の ID のまま
  useEffect(() => {
    if (!ready || itineraryId === null) return;
    let active = true;
    void resolveShioriUrl(account, itineraryId, window.location.origin).then(
      (url) => {
        if (active) setResolved({ key, url });
      },
      () => {
        if (active) setResolved({ key, url: null });
      },
    );
    return () => {
      active = false;
    };
  }, [account, ready, itineraryId, key]);

  if (itinerary === null) {
    return null;
  }
  const settled = resolved?.key === key;
  const shareUrl = ready && settled ? resolved.url : null;

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
        {shioriOpen ? (
          <button
            type="button"
            className={buttonPrimary}
            data-testid="shiori-go-outside"
            onClick={() => actions.leaveWithGuide()}
          >
            {t.street.goOutside}
          </button>
        ) : null}
        <KeepTrip />
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
            <SavePdfButton key={shareUrl} url={`${shareUrl}.pdf`} />
          </div>
        )}
        {shareUrl === null ? null : <ShareBox url={shareUrl} />}
      </div>
      {!ready ? (
        <p className="m-4 rounded-xl bg-kinari-50 p-4 text-ink">{t.shiori.notReady}</p>
      ) : !settled ? (
        <p role="status" className="m-4 rounded-xl bg-kinari-50 p-4 text-ink">
          {t.shiori.preparing}
        </p>
      ) : shareUrl === null ? (
        <div
          role="alert"
          className="m-4 grid justify-items-start gap-3 rounded-xl bg-kinari-50 p-4 text-ink"
        >
          <p>{t.shiori.prepareFailed}</p>
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => setAttempt((count) => count + 1)}
          >
            {t.shiori.retry}
          </button>
        </div>
      ) : (
        <iframe
          ref={frameRef}
          src={`${shareUrl}?embed=1&lang=${locale}`}
          title={t.shiori.booklet}
          className="min-h-0 w-full flex-1 border-0"
          data-testid="shiori-booklet"
        />
      )}
    </div>
  );
}
