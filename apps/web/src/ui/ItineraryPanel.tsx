import type { Itinerary, ItineraryItem } from "@matsuri-ikoka/schema";
import { type KeyboardEvent, lazy, Suspense, useRef } from "react";
import { formatDate, formatDateTime, type Messages } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { itemChange, shioriReady, usedSources } from "../state/selectors";
import { PANEL_TABS, type PanelTab, type VerifyState } from "../state/types";
import { buttonPrimary, Pill, SourceLink } from "./common";

// 右のパネル：旅程・地図・出典のタブ。変わった予定は山吹色で示す。

const MapView = lazy(() => import("./MapView"));

export function weatherText(t: Messages, itinerary: Itinerary): string {
  const weather = itinerary.weather;
  switch (weather.status) {
    case "forecast":
      return t.itinerary.weather.forecast(
        weather.summary,
        weather.precipitationPercent,
        weather.highC,
        weather.lowC,
      );
    case "not_yet":
      return t.itinerary.weather.not_yet;
    case "unavailable":
      return t.itinerary.weather.unavailable;
  }
}

export function VerificationLine({ verify }: { verify: VerifyState }) {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const text =
    verify.status === "checking"
      ? t.itinerary.verification.checking
      : verify.result === null
        ? t.itinerary.verification.pending
        : t.itinerary.verification[verify.result];
  const tone =
    verify.result === "as_planned"
      ? "text-emerald-800"
      : verify.result === null
        ? "text-ink-soft"
        : "text-shu-700";
  return (
    <p className={`font-semibold text-sm ${tone}`} data-testid="verification">
      {text}
      {verify.checkedAt !== null ? (
        <span className="ml-1 font-normal text-ink-soft">
          （{t.itinerary.verification.checkedAt(formatDateTime(verify.checkedAt, locale))}）
        </span>
      ) : null}
    </p>
  );
}

function ItemRow({ item, main }: { item: ItineraryItem; main: boolean }) {
  const t = useT();
  const change = useApp((state) => itemChange(state, item));
  const highlight =
    change === null
      ? main
        ? "border-shu-600 bg-white"
        : "border-wood-300 bg-white"
      : "border-yamabuki-400 bg-yamabuki-100";
  return (
    <li
      className={`rounded-xl border-l-[6px] px-3 py-2 shadow-sm ring-1 ring-kinari-300 ${highlight}`}
      data-testid="itinerary-item"
      data-item-id={item.id}
      data-change={change ?? "none"}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-bold font-mono text-ink tabular-nums">
          {item.start}〜{item.end}
        </span>
        <Pill tone={main ? "shu" : "wood"}>{t.itinerary.types[item.type]}</Pill>
        {change === null ? null : (
          <Pill tone="yamabuki">
            {change === "added" ? t.itinerary.added : t.itinerary.changed}
          </Pill>
        )}
      </div>
      <p className="mt-0.5 font-bold text-ink">{item.name}</p>
      <p className="text-ink text-sm">
        <span className="sr-only">{t.itinerary.reason}：</span>
        {item.reason}
      </p>
      <div className="mt-1 flex flex-wrap gap-x-3 text-ink-soft text-xs">
        {item.move === null ? null : (
          <span>
            {t.itinerary.move(
              t.itinerary.means[item.move.means],
              item.move.minutes[0],
              item.move.minutes[1],
            )}
            {item.move.note === undefined ? null : `・${item.move.note}`}
          </span>
        )}
        {item.hours === null ? null : (
          <span>{t.itinerary.hours(item.hours.open, item.hours.close, item.hours.lastEntry)}</span>
        )}
        {item.cost === null ? null : (
          <span>
            {t.itinerary.cost}：{item.cost}
          </span>
        )}
      </div>
      {item.sources.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {item.sources.map((source) => (
            <li key={source.url}>
              <SourceLink source={source} compact />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ItineraryTab() {
  const t = useT();
  const itinerary = useApp((state) => state.itinerary.current);
  const removed = useApp((state) =>
    state.itinerary.diff !== null && state.itinerary.diff.fromVersion > 0
      ? state.itinerary.diff.removed
      : [],
  );
  if (itinerary === null) {
    return <p className="p-4 text-ink-soft">{t.itinerary.empty}</p>;
  }
  return (
    <div className="space-y-4 p-3">
      <ol className="space-y-2">
        {itinerary.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            main={item.type === "festival" && item.festivalId === itinerary.mainFestivalId}
          />
        ))}
      </ol>
      {removed.length > 0 ? (
        <section className="rounded-xl border-2 border-dashed border-yamabuki-400 p-3">
          <h3 className="font-bold text-sm text-yamabuki-700">{t.itinerary.removed}</h3>
          <ul className="list-disc pl-5 text-sm line-through">
            {removed.map((item) => (
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {itinerary.notes.length > 0 ? (
        <section>
          <h3 className="font-bold text-ai-700 text-sm">{t.itinerary.notes}</h3>
          <ul className="list-disc pl-5 text-sm">
            {itinerary.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {itinerary.alternatives.length > 0 ? (
        <section>
          <h3 className="font-bold text-ai-700 text-sm">{t.itinerary.alternatives}</h3>
          <ul className="space-y-1 text-sm">
            {itinerary.alternatives.map((alternative) => (
              <li key={alternative.summary}>
                <span className="font-semibold">{t.itinerary.altKinds[alternative.kind]}：</span>
                {alternative.summary}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function SourcesTab() {
  const t = useT();
  const sources = useApp(usedSources);
  return (
    <div className="space-y-3 p-3">
      <h3 className="font-bold text-ai-700 text-sm">{t.sources.title}</h3>
      {sources.length === 0 ? (
        <p className="text-ink-soft">{t.sources.empty}</p>
      ) : (
        <ul className="space-y-2" data-testid="source-list">
          {sources.map((source) => (
            <li key={source.url} className="rounded-lg bg-white px-3 py-2 ring-1 ring-kinari-300">
              <SourceLink source={source} />
            </li>
          ))}
        </ul>
      )}
      <p className="font-semibold text-ink text-sm">{t.sources.finalCheck}</p>
    </div>
  );
}

export function ItineraryPanel() {
  const t = useT();
  const actions = useActions();
  const tab = useApp((state) => state.ui.tab);
  const itinerary = useApp((state) => state.itinerary.current);
  const verify = useApp((state) => state.verify);
  const locale = useApp((state) => state.ui.locale);
  const ready = useApp(shioriReady);
  const tabRefs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});

  // 左右の矢印キーでタブを移る
  const onKeyDown = (event: KeyboardEvent) => {
    const index = PANEL_TABS.indexOf(tab);
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    const next = PANEL_TABS[(index + delta + PANEL_TABS.length) % PANEL_TABS.length] ?? "itinerary";
    actions.setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section
      aria-label={t.itinerary.panelLabel}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border-2 border-wood-700 bg-kinari-50 shadow-lg"
      data-testid="itinerary-panel"
    >
      <div
        role="tablist"
        aria-label={t.itinerary.panelLabel}
        className="flex shrink-0 gap-1 bg-wood-700 px-2 pt-2"
        onKeyDown={onKeyDown}
      >
        {PANEL_TABS.map((id) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              ref={(element) => {
                tabRefs.current[id] = element;
              }}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={selected}
              aria-controls={`panel-${id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => actions.setTab(id)}
              className={`min-h-11 flex-1 rounded-t-xl px-3 py-2 font-bold transition ${
                selected ? "bg-kinari-50 text-ai-800" : "bg-ai-700 text-white hover:bg-ai-600"
              }`}
            >
              {t.itinerary.tabs[id]}
            </button>
          );
        })}
      </div>

      {itinerary === null ? null : (
        <header className="shrink-0 border-kinari-300 border-b px-3 py-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <h2 className="font-bold text-ink text-lg leading-snug">{itinerary.title}</h2>
            <Pill tone="ai">{t.itinerary.version(itinerary.version)}</Pill>
          </div>
          <p className="text-ink text-sm">
            {formatDate(itinerary.date, locale)}・{itinerary.origin}
            <span className="ml-2 text-ink-soft">
              {t.itinerary.weather.title}：{weatherText(t, itinerary)}
            </span>
          </p>
          <VerificationLine verify={verify} />
          {ready ? (
            <button
              type="button"
              className={`${buttonPrimary} mt-2 w-full`}
              onClick={() => actions.openShiori()}
            >
              {t.itinerary.openShiori}
            </button>
          ) : null}
        </header>
      )}

      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        {tab === "itinerary" ? <ItineraryTab /> : null}
        {tab === "map" ? (
          <Suspense fallback={<p className="p-4 text-ink-soft">…</p>}>
            <MapView />
          </Suspense>
        ) : null}
        {tab === "sources" ? <SourcesTab /> : null}
      </div>
    </section>
  );
}
