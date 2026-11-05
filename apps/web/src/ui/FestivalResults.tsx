import type { FestivalSearchResult } from "@matsuri-ikoka/schema";
import { Check, CircleAlert, Lightbulb, LoaderCircle, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useActions, useApp, useT } from "../state/react";
import { Card, Row, ViewSwitch } from "./CandidateCards";
import { FestivalBand } from "./candidates/Art";
import type { CandidateView } from "./candidates/view";
import { focusStep } from "./consult/Choices";
import { LanternIcon } from "./icons";
import { Portrait } from "./Portraits";
import { loadCandidateView, saveCandidateView } from "./storage";
import { errorText } from "./text";

// 祭りから探した結果の一覧。候補の画面と同じカードと行で、最大6件ずつ出す。
// 「別の祭りを提案してもらう」で続きを下に足し、前に見た祭りと見比べられるようにする。
// 見終えたら「これで全部です」と次の手を、0件なら外れている点つきの祭りと次の手を出す。
// 合った理由・要事前確認・出典はカードの面に出す。祭りの文字列はすべて文字として出す。

const quietButton =
  "inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-wood-700/30 bg-kinari-50 px-4 font-bold text-ink shadow-soft transition hover:bg-yamabuki-200 disabled:cursor-not-allowed disabled:opacity-60";

/** カードの面に添える：合った種類・理由・自由記述に合うか */
function ResultNote({ result }: { result: FestivalSearchResult }) {
  const t = useT();
  const words = t.festivalSearch.results;
  return (
    <div className="space-y-1" data-testid="festival-result-note">
      {result.matchedKinds.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1">
          {result.matchedKinds.map((kind) => (
            <li
              key={kind}
              className="rounded-full bg-yamabuki-200 px-2 py-0.5 font-bold text-ink text-xs"
            >
              {t.festivalSearch.kinds[kind]}
            </li>
          ))}
        </ul>
      )}
      {result.reasons.length === 0 ? null : (
        <ul className="space-y-0.5" aria-label={words.reasons}>
          {result.reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-1.5 text-ink text-sm">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-700" />
              {reason}
            </li>
          ))}
        </ul>
      )}
      {result.wishFit === null ? null : result.wishFit === "none" ? (
        <p className="flex items-start gap-1.5 font-bold text-ink-soft text-sm">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {words.wishNone}
        </p>
      ) : (
        <p className="flex items-start gap-1.5 font-bold text-emerald-800 text-sm">
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {result.wishFit === "matched" ? words.wishMatched : words.wishPartial}
        </p>
      )}
    </div>
  );
}

/** 一覧の下の段：続きを出すボタン、または「これで全部です」と次の手 */
function ResultsFooter() {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const actions = useActions();
  const count = useApp((state) => state.festivalSearch.results.length);
  const remaining = useApp((state) => state.festivalSearch.remaining);
  const next = useApp((state) => state.festivalSearch.next);
  const loading = useApp((state) => state.festivalSearch.loadingMore);
  const error = useApp((state) => state.festivalSearch.error);
  const words = t.festivalSearch.results;
  const steps = next.filter((step) => step.kind !== "edit_conditions");
  return (
    <section
      aria-label={words.nextTitle}
      className="washi mx-auto mt-4 flex max-w-6xl flex-col gap-2 rounded-card border border-line-strong px-4 py-3 shadow-soft"
      data-testid="festival-results-footer"
    >
      {error === null ? null : (
        <p
          role="alert"
          className="font-bold text-shu-700 text-sm"
          data-testid="festival-more-error"
        >
          {errorText(error, locale, t)}
        </p>
      )}
      {remaining === 0 && count > 0 ? (
        <p role="status" className="font-black text-ink text-lg" data-testid="festival-all-shown">
          {words.allShown}
        </p>
      ) : null}
      {remaining === 0 && steps.length > 0 ? (
        <h3 className="font-black text-ink">{words.nextTitle}</h3>
      ) : null}
      <ul className="flex flex-wrap items-center gap-2">
        {remaining > 0 ? (
          <li>
            <button
              type="button"
              className="inline-flex min-h-12 items-center gap-1.5 rounded-full border-2 border-wood-700/30 bg-yamabuki-400 px-5 font-black text-ink shadow-soft transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={loading}
              data-testid="festival-more"
              onClick={() => void actions.moreFestivals()}
            >
              {loading ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
              ) : (
                <Search aria-hidden="true" className="size-4" />
              )}
              {loading ? words.loadingMore : words.more}
              {loading ? null : (
                <span className="rounded-full bg-kinari-50 px-2 py-0.5 text-xs">
                  {words.remaining(remaining)}
                </span>
              )}
            </button>
          </li>
        ) : (
          steps.map((step) => (
            <li key={step.kind}>
              <button
                type="button"
                className={quietButton}
                disabled={loading}
                data-testid="festival-next"
                onClick={() => void actions.chooseFestivalNext(step)}
              >
                {words.nextLabel(step)}
                {step.found === null ? null : (
                  <span className="rounded-full bg-yamabuki-400 px-2 py-0.5 text-xs">
                    {t.candidates.next.found(step.found)}
                  </span>
                )}
              </button>
            </li>
          ))
        )}
        <li>
          <button
            type="button"
            className={quietButton}
            data-testid="festival-edit-conditions"
            onClick={() => {
              actions.editFestivalConditions();
              focusStep();
            }}
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            {t.consult.reopen}
          </button>
        </li>
      </ul>
    </section>
  );
}

export function FestivalResults() {
  const t = useT();
  const actions = useActions();
  const open = useApp(
    (state) =>
      state.consult.active &&
      state.consult.entry === "festival" &&
      state.festivalSearch.phase === "results" &&
      state.festivalSearch.resultsOpen,
  );
  const results = useApp((state) => state.festivalSearch.results);
  const nearMatches = useApp((state) => state.festivalSearch.nearMatches);
  const reading = useApp((state) => state.festivalSearch.reading);
  const remaining = useApp((state) => state.festivalSearch.remaining);
  const festivals = useApp((state) => state.festivals);
  const [view, setView] = useState<CandidateView>(loadCandidateView);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const shownBefore = useRef(0);
  const words = t.festivalSearch.results;

  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open]);
  // 続きを足したら、足した最初の祭りへ焦点を移す（見ていた場所が上にずれないよう、1件目へは移さない）
  useEffect(() => {
    if (open && shownBefore.current > 0 && results.length > shownBefore.current) {
      listRef.current?.querySelectorAll<HTMLElement>("article")[shownBefore.current]?.focus();
    }
    shownBefore.current = results.length;
  }, [open, results.length]);

  if (!open) return null;

  const pick = (result: FestivalSearchResult) => () => {
    actions.chooseFestival(result);
    focusStep();
  };
  const close = () => {
    actions.setFestivalResultsOpen(false);
    focusStep();
  };
  const changeView = (next: CandidateView) => {
    setView(next);
    saveCandidateView(next);
  };
  const line =
    results.length === 0
      ? words.noneLine
      : remaining === 0
        ? words.allShownLine
        : words.found(results.length);

  return (
    <section
      aria-labelledby="festival-results-title"
      className="fixed inset-0 z-40 overflow-y-auto bg-wood-900/55 p-3 backdrop-blur-[3px] sm:p-6"
      data-testid="festival-results"
      data-view={view}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <div className="relative mx-auto mb-3 flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <FestivalBand className="-z-10 pointer-events-none absolute top-0 right-40 hidden h-[4.75rem] w-[26rem] lg:block" />
        <div className="flex min-w-0 items-center gap-3">
          <Portrait speaker="concierge" className="size-14" />
          <div className="min-w-0">
            <h2
              id="festival-results-title"
              ref={headingRef}
              tabIndex={-1}
              className="flex items-center gap-2 font-black text-2xl text-kinari-50 drop-shadow"
            >
              <LanternIcon className="size-6 text-yamabuki-400" />
              {words.title}
              <span className="rounded-full bg-kinari-50/90 px-2 py-0.5 font-bold text-ink text-xs">
                {words.count(results.length)}
              </span>
            </h2>
            <p className="font-bold text-kinari-100 text-sm" data-testid="festival-results-line">
              {line}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="hud-chip inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 font-bold"
          onClick={close}
        >
          <X aria-hidden="true" className="size-4" />
          {words.close}
        </button>
      </div>

      <div className="washi mx-auto mb-4 flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line-strong px-4 py-2 shadow-soft">
        {reading === null ? null : (
          <p
            className="flex min-w-0 items-start gap-1.5 font-bold text-ink text-sm"
            data-testid="festival-reading"
          >
            <Lightbulb aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-yamabuki-700" />
            <span className="min-w-0">{words.reading(reading.text)}</span>
            <button
              type="button"
              className="shrink-0 text-ai-700 text-xs underline underline-offset-2"
              onClick={() => {
                actions.editFestivalConditions("wish");
                focusStep();
              }}
            >
              {words.editWish}
            </button>
          </p>
        )}
        <ViewSwitch view={view} onChange={changeView} />
      </div>

      {results.length === 0 ? (
        <p
          className="washi mx-auto max-w-6xl rounded-card border-2 border-shu-500/50 px-4 py-3 font-black text-ink text-xl"
          role="status"
          data-testid="festival-results-none"
        >
          {words.none}
        </p>
      ) : null}

      <div ref={listRef}>
        {view === "list" ? (
          <ul className="mx-auto flex max-w-6xl flex-col gap-2" aria-label={t.candidates.view.list}>
            {results.map((result) => (
              <Row
                key={result.candidate.festivalId}
                candidate={result.candidate}
                festival={festivals[result.candidate.festivalId] ?? null}
                pick={pick(result)}
                note={<ResultNote result={result} />}
              />
            ))}
          </ul>
        ) : (
          <div className="mx-auto flex max-w-6xl flex-col gap-4">
            {results.map((result, index) => (
              <Card
                key={result.candidate.festivalId}
                candidate={result.candidate}
                festival={festivals[result.candidate.festivalId] ?? null}
                index={index % 6}
                pick={pick(result)}
                note={<ResultNote result={result} />}
              />
            ))}
          </div>
        )}
      </div>

      {nearMatches.length === 0 ? null : (
        <section
          aria-labelledby="festival-near-title"
          className="mx-auto mt-4 flex max-w-6xl flex-col gap-2"
          data-testid="festival-near-matches"
        >
          <div className="washi rounded-card border border-line-strong px-4 py-2 shadow-soft">
            <h3 id="festival-near-title" className="font-black text-ink text-lg">
              {words.nearTitle}
            </h3>
            <p className="text-ink-soft text-sm">{words.nearNote}</p>
          </div>
          <ul className="flex flex-col gap-2">
            {nearMatches.map((near) => (
              <Row
                key={near.result.candidate.festivalId}
                candidate={near.result.candidate}
                festival={festivals[near.result.candidate.festivalId] ?? null}
                miss={near.miss}
                pick={pick(near.result)}
                note={<ResultNote result={near.result} />}
              />
            ))}
          </ul>
        </section>
      )}

      <ResultsFooter />
    </section>
  );
}
