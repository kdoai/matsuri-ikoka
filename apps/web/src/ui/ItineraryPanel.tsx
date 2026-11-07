import {
  googleMapsUrl,
  type ItineraryDay,
  type ItineraryItem,
  type LodgingOffer,
  type LodgingSearch,
  mainFestivalDay,
  type Party,
  type TripBudget,
  tripBudgetAmounts,
  type Weather,
} from "@matsuri-ikoka/schema";
import {
  BedDouble,
  BookOpen,
  CalendarDays,
  ChevronRight,
  Landmark,
  ListChecks,
  type LucideIcon,
  MapPin,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { type KeyboardEvent, lazy, type ReactNode, Suspense, useRef, useState } from "react";
import { formatDate, formatDateTime, type Messages } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { itemChange, shioriReady, usedSources } from "../state/selectors";
import { PANEL_TABS, type PanelTab, type VerifyState } from "../state/types";
import { buttonPrimary, SourceLink } from "./common";
import { ErrorBoundary } from "./ErrorBoundary";
import { itemIcon, LanternIcon } from "./icons";
import { MapTrouble } from "./MapPlaces";

// 旅のしおりの窓：旅程・旅の案内・持ち物と確認のタブ。
// 旅程は、表題・日付・同行者・道のりのひとことのカードと、日ごとの時刻・アイコン・予定の縦の並びで見せる。
// 行を押すと、理由・移動・営業時間・出典をその場で開く。変わった予定は山吹色で示し、組み直したら「更新！」の札を貼る。
// 文字は 16px（text-base）より小さくしない。

const TAB_ICON: Record<PanelTab, LucideIcon> = {
  itinerary: CalendarDays,
  map: Landmark,
  sources: ListChecks,
};

const loadMapView = () => import("./MapView");
const MapView = lazy(loadMapView);

/**
 * 地図のコードを先に取っておく。ページを開いたあとに新しい版が公開されると、
 * このページの知っているファイルは取れなくなるので、押されるまで待たない
 */
export function preloadMapView(): void {
  void loadMapView().catch(() => undefined);
}

/** 旅の予算を、言われた数え方と、コードで換算したもう一方で書く */
export function budgetText(t: Messages, budget: TripBudget, party: Party): string {
  const amounts = tripBudgetAmounts(budget, party);
  const converted = budget.basis === "perPerson" ? amounts.totalYen : amounts.perPersonYen;
  return t.conditions.budget(budget.basis, budget.yen, converted);
}

export function weatherText(t: Messages, weather: Weather): string {
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
      : verify.result === "needs_check"
        ? "text-amber-800"
        : verify.result === null
          ? "text-ink-soft"
          : "text-shu-700";
  return (
    <p className={`font-semibold text-base ${tone}`} data-testid="verification">
      {text}
      {verify.checkedAt !== null ? (
        <span className="ml-1 font-normal text-ink-soft">
          （{t.itinerary.verification.checkedAt(formatDateTime(verify.checkedAt, locale))}）
        </span>
      ) : null}
    </p>
  );
}

/** 小さな札（文字は 16px） */
function Tag({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "ai" | "shu" | "yamabuki" | "wood";
}) {
  const tones = {
    ai: "bg-ai-700 text-white",
    shu: "bg-shu-600 text-white",
    yamabuki: "bg-yamabuki-200 text-yamabuki-700 ring-1 ring-yamabuki-400",
    wood: "bg-wood-100 text-wood-800 ring-1 ring-wood-300",
  };
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 font-bold text-base leading-snug ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-bold text-ai-800 text-lg">{children}</h3>;
}

/** 予定の1行。押すと、くわしい中身（理由・移動・営業時間・費用・出典）を開く */
function ItemRow({ item, main }: { item: ItineraryItem; main: boolean }) {
  const t = useT();
  const change = useApp((state) => itemChange(state, item));
  const [open, setOpen] = useState(false);
  const Icon = itemIcon(item);
  const detailId = `item-detail-${item.id}`;
  const iconTone = main
    ? "bg-shu-600 text-white"
    : change !== null
      ? "bg-yamabuki-200 text-ink"
      : "bg-ai-50 text-ai-800";
  return (
    <li
      className="relative pl-7"
      data-testid="itinerary-item"
      data-item-id={item.id}
      data-change={change ?? "none"}
    >
      {/* 時刻の縦の線の上の丸 */}
      <span
        aria-hidden="true"
        className="absolute top-5 left-0.5 size-4 rounded-full border-[3px] border-yamabuki-400 bg-washi"
      />
      <div
        className={`rounded-2xl border transition ${
          change === null
            ? main
              ? "border-shu-600/50 bg-white"
              : "border-line bg-white/80"
            : "border-yamabuki-400 bg-yamabuki-100"
        }`}
      >
        <button
          type="button"
          className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-white"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen(!open)}
        >
          <span className="w-14 shrink-0 font-bold text-base text-ink tabular-nums">
            {item.start}
          </span>
          <span
            aria-hidden="true"
            className={`grid size-10 shrink-0 place-items-center rounded-full ${iconTone}`}
          >
            <Icon className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-base text-ink leading-snug">{item.name}</span>
            {change === null ? null : (
              <span className="mt-0.5 block">
                <Tag tone="yamabuki">
                  {change === "added" ? t.itinerary.added : t.itinerary.changed}
                </Tag>
              </span>
            )}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={`size-5 shrink-0 text-wood-500 transition ${open ? "rotate-90" : ""}`}
          />
        </button>
        {open ? (
          <div id={detailId} className="space-y-1.5 border-line border-t px-4 pt-2 pb-3 text-base">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-bold tabular-nums">
                {item.start}〜{item.end}
              </span>
              <Tag tone={main ? "shu" : "wood"}>{t.itinerary.types[item.type]}</Tag>
            </p>
            <p className="text-ink">
              <span className="font-bold">{t.itinerary.reason}：</span>
              {item.reason}
            </p>
            {item.move === null ? null : (
              <p className="text-ink-soft">
                {t.itinerary.move(
                  t.itinerary.means[item.move.means],
                  item.move.minutes[0],
                  item.move.minutes[1],
                )}
                {item.move.note === undefined ? null : `・${item.move.note}`}
              </p>
            )}
            {item.hours === null ? null : (
              <p className="text-ink-soft">
                {t.itinerary.hours(item.hours.open, item.hours.close, item.hours.lastEntry)}
              </p>
            )}
            {item.cost === null ? null : (
              <p className="text-ink-soft">
                {t.itinerary.cost}：{item.cost}
              </p>
            )}
            {item.location === null || item.type === "move" ? null : (
              <p>
                <a
                  href={googleMapsUrl({ name: item.name, location: item.location })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ai-700 underline decoration-ai-200 underline-offset-2 hover:decoration-ai-600"
                  data-testid="open-google-maps"
                >
                  {t.itinerary.openInGoogleMaps}
                </a>
              </p>
            )}
            {item.sources.length > 0 ? (
              <ul className="space-y-0.5">
                {item.sources.map((source) => (
                  <li key={source.url}>
                    <SourceLink source={source} compact size="base" />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** 「n日目（日付）」の見出しと、その日の予定の縦の並び */
function DaySection({
  day,
  dayNumber,
  mainFestivalId,
}: {
  day: ItineraryDay;
  dayNumber: number;
  mainFestivalId: string;
}) {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  return (
    <section aria-labelledby={`day-title-${dayNumber}`} data-testid="day-card">
      <h3
        id={`day-title-${dayNumber}`}
        className="inline-flex items-center gap-2 rounded-full bg-wood-700 py-1 pr-4 pl-3 font-bold text-base text-kinari-50"
      >
        <CalendarDays aria-hidden="true" className="size-5" />
        {t.itinerary.dayHeading(dayNumber, formatDate(day.date, locale))}
      </h3>
      <ol className="relative mt-2 space-y-1.5 before:absolute before:top-6 before:bottom-6 before:left-[0.95rem] before:w-0.5 before:bg-yamabuki-400">
        {day.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            main={item.type === "festival" && item.festivalId === mainFestivalId}
          />
        ))}
      </ol>
      {day.stay === null ? null : (
        <p className="mt-1.5 pl-7 text-base text-ink-soft">{t.itinerary.stay(day.stay.area)}</p>
      )}
      {day.stay?.lodging === undefined || day.stay.lodging.offers.length === 0 ? null : (
        <StayLodging search={day.stay.lodging} />
      )}
    </section>
  );
}

/** 宿の候補の目安（会場からの距離と移動・料金）。分かるものだけ */
function offerDetails(offer: LodgingOffer, t: Messages): string[] {
  const words = t.itinerary.lodging;
  const details: string[] = [];
  if (offer.fromVenue !== undefined) {
    const { distanceKm, mode, minutes } = offer.fromVenue;
    details.push(
      mode === "walk"
        ? words.fromVenueWalk(distanceKm, minutes[0], minutes[1])
        : words.fromVenueRide(distanceKm, minutes[0], minutes[1]),
    );
  }
  if (offer.nightlyTotalYen !== null) details.push(words.nightlyTotal(offer.nightlyTotalYen));
  else if (offer.perPersonNightYen !== undefined)
    details.push(words.perPersonNight(offer.perPersonNightYen[0], offer.perPersonNightYen[1]));
  else if (offer.priceNote !== undefined) details.push(offer.priceNote);
  return details;
}

/** その夜に泊まる宿の候補（1〜3件）。名前は宿のページへのリンクにする */
function StayLodging({ search }: { search: LodgingSearch }) {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const words = t.itinerary.lodging;
  const provider = search.provider ?? "rakuten";
  return (
    <div
      className="mt-1.5 ml-7 rounded-xl border border-line-strong bg-white/90 p-2.5"
      data-testid="stay-lodging"
    >
      <p className="flex items-center gap-1.5 font-bold text-base text-ink">
        <BedDouble aria-hidden="true" className="size-5" />
        {words.heading}
      </p>
      <ul className="mt-1 space-y-2">
        {search.offers.slice(0, 3).map((offer) => (
          <li key={offer.id} className="border-line border-t border-dashed pt-1.5 text-base">
            <a
              href={offer.bookingUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${offer.name}（${words.open}）`}
              className="break-all font-bold text-ai-700 underline decoration-ai-200 underline-offset-2 hover:decoration-ai-600"
            >
              {offer.name}
            </a>
            {offer.location === null ? null : (
              <a
                href={googleMapsUrl({ name: offer.name, location: offer.location })}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-ai-700 underline decoration-ai-200 underline-offset-2 hover:decoration-ai-600"
              >
                {t.itinerary.openInGoogleMaps}
              </a>
            )}
            {offer.perspectives !== undefined && offer.perspectives.length > 0 ? (
              <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                {offer.perspectives.map((p) => (
                  <span
                    key={p}
                    className="rounded-full bg-yamabuki-100 px-2 text-base text-wood-700"
                  >
                    {words.perspectives[p]}
                  </span>
                ))}
              </span>
            ) : null}
            {offerDetails(offer, t).map((detail) => (
              <p key={detail} className="text-ink-soft">
                {detail}
              </p>
            ))}
            {offer.summary === undefined ? null : <p className="text-ink">{offer.summary}</p>}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-base text-ink-soft">
        {words.searchedAt(formatDateTime(search.searchedAt, locale))}・{words.notes[provider]}
      </p>
      {search.provider === "rakuten" ? (
        <p className="text-base text-ink-soft">Supported by Rakuten Developers</p>
      ) : null}
    </div>
  );
}

/** 表題のカード：表題・版・日付・同行者・出発の駅・道のりのひとこと・開催の確認 */
function TripCard() {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const itinerary = useApp((state) => state.itinerary.current);
  const verify = useApp((state) => state.verify);
  const ready = useApp(shioriReady);
  const updated = useApp(
    (state) => state.itinerary.diff !== null && state.itinerary.diff.fromVersion > 0,
  );
  if (itinerary === null) return null;
  const day = mainFestivalDay(itinerary);
  const route = itinerary.days.flatMap((d) => d.items.map((item) => item.name)).join(" → ");
  return (
    <section
      aria-labelledby="trip-card-title"
      className="relative rounded-2xl border border-line-strong bg-white/90 p-3 shadow-soft"
      data-testid="trip-card"
    >
      {updated ? (
        <p
          className="-top-3 absolute right-3 rotate-6 rounded-md bg-yamabuki-400 px-2.5 py-1 font-black text-ink shadow-md ring-2 ring-white"
          data-testid="updated-sticker"
        >
          {t.panel.updated}
        </p>
      ) : null}
      <div className="flex gap-3">
        <span
          aria-hidden="true"
          className="grid size-16 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#a3471a] to-[#e9a23b] text-kinari-50 shadow-sm"
        >
          <LanternIcon className="size-9" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 id="trip-card-title" className="font-bold text-ink text-xl leading-snug">
              {itinerary.title}
            </h2>
            <Tag tone="ai">{t.itinerary.version(itinerary.version)}</Tag>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-base text-ink">
            <span className="inline-flex items-center gap-1">
              <CalendarDays aria-hidden="true" className="size-4 text-wood-600" />
              {formatDate(day.date, locale)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Users aria-hidden="true" className="size-4 text-wood-600" />
              {t.conditions.party(itinerary.party.adults, itinerary.party.children)}
            </span>
            <span className="inline-flex items-center gap-1">
              <MapPin aria-hidden="true" className="size-4 text-wood-600" />
              {t.conditions.origin(itinerary.origin)}
            </span>
            {itinerary.budget === undefined ? null : (
              <span className="inline-flex items-center gap-1" data-testid="trip-budget">
                <Wallet aria-hidden="true" className="size-4 text-wood-600" />
                {budgetText(t, itinerary.budget, itinerary.party)}
              </span>
            )}
          </p>
        </div>
      </div>
      <p className="mt-2 text-base text-ink-soft leading-relaxed">
        <span className="sr-only">{t.itinerary.route}：</span>
        {route}
      </p>
      <p className="text-base text-ink-soft">
        {t.itinerary.weather.title}：{weatherText(t, day.weather)}
      </p>
      <VerificationLine verify={verify} />
      {ready ? (
        <button
          type="button"
          className={`${buttonPrimary} mt-2 w-full text-base`}
          onClick={() => actions.openShiori()}
        >
          <BookOpen aria-hidden="true" className="size-5" />
          {t.itinerary.openShiori}
        </button>
      ) : null}
    </section>
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
    return <p className="p-4 text-base text-ink-soft">{t.itinerary.empty}</p>;
  }
  return (
    <div className="space-y-4 p-3">
      <TripCard />
      {itinerary.days.map((day, index) => (
        <DaySection
          key={day.date}
          day={day}
          dayNumber={index + 1}
          mainFestivalId={itinerary.mainFestivalId}
        />
      ))}
      {removed.length > 0 ? (
        <section className="rounded-xl border-2 border-dashed border-yamabuki-400 p-3">
          <h3 className="font-bold text-base text-yamabuki-700">{t.itinerary.removed}</h3>
          <ul className="list-disc pl-5 text-base line-through">
            {removed.map((item) => (
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** 旅の案内：道のりの地図、日ごとの天気、行けないときの代わり */
function GuideTab() {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const itinerary = useApp((state) => state.itinerary.current);
  return (
    <div className="space-y-4">
      <ErrorBoundary name="map" fallback={<MapTrouble />}>
        <Suspense fallback={<p className="p-4 text-base text-ink-soft">…</p>}>
          <MapView textClass="text-base" />
        </Suspense>
      </ErrorBoundary>
      {itinerary === null ? null : (
        <div className="space-y-4 px-3 pb-3">
          <section className="space-y-1">
            <SectionTitle>{t.itinerary.weather.title}</SectionTitle>
            <ul className="space-y-0.5 text-base">
              {itinerary.days.map((day, index) => (
                <li key={day.date}>
                  <span className="font-bold">
                    {t.itinerary.dayHeading(index + 1, formatDate(day.date, locale))}
                  </span>
                  ：{weatherText(t, day.weather)}
                </li>
              ))}
            </ul>
          </section>
          {itinerary.alternatives.length > 0 ? (
            <section className="space-y-1">
              <SectionTitle>{t.itinerary.alternatives}</SectionTitle>
              <ul className="space-y-1 text-base">
                {itinerary.alternatives.map((alternative) => (
                  <li key={alternative.summary}>
                    <span className="font-bold">{t.itinerary.altKinds[alternative.kind]}：</span>
                    {alternative.summary}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 持ち物と確認：開催の確認、持ち物と注意、出典 */
function ConfirmTab() {
  const t = useT();
  const actions = useActions();
  const itinerary = useApp((state) => state.itinerary.current);
  const verify = useApp((state) => state.verify);
  const ready = useApp(shioriReady);
  const sources = useApp(usedSources);
  return (
    <div className="space-y-4 p-3">
      {itinerary === null ? null : (
        <section className="space-y-1">
          <SectionTitle>{t.itinerary.verification.title}</SectionTitle>
          <VerificationLine verify={verify} />
          {ready ? (
            <button
              type="button"
              className={`${buttonPrimary} mt-1 w-full text-base`}
              onClick={() => actions.openShiori()}
            >
              <BookOpen aria-hidden="true" className="size-5" />
              {t.itinerary.openShiori}
            </button>
          ) : null}
        </section>
      )}
      {itinerary !== null && itinerary.notes.length > 0 ? (
        <section className="space-y-1">
          <SectionTitle>{t.itinerary.notes}</SectionTitle>
          <ul className="list-disc space-y-0.5 pl-5 text-base">
            {itinerary.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="space-y-2">
        <SectionTitle>{t.sources.title}</SectionTitle>
        {sources.length === 0 ? (
          <p className="text-base text-ink-soft">{t.sources.empty}</p>
        ) : (
          <ul className="space-y-2" data-testid="source-list">
            {sources.map((source) => (
              <li key={source.url} className="rounded-lg bg-white px-3 py-2 ring-1 ring-kinari-300">
                <SourceLink source={source} size="base" />
              </li>
            ))}
          </ul>
        )}
        <p className="font-semibold text-base text-ink">{t.sources.finalCheck}</p>
      </section>
    </div>
  );
}

export function ItineraryPanel() {
  const t = useT();
  const actions = useActions();
  const tab = useApp((state) => state.ui.tab);
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
      className="washi relative flex h-full min-h-0 flex-col overflow-hidden rounded-panel border-2 border-wood-700/50 shadow-lift"
      data-testid="itinerary-panel"
    >
      <div className="flex shrink-0 items-center gap-2 bg-wood-700 px-4 py-2 text-kinari-50">
        <p className="flex min-w-0 flex-1 items-center gap-2 font-bold text-xl tracking-widest">
          <BookOpen aria-hidden="true" className="size-6 shrink-0" />
          {t.hud.bookletTitle}
        </p>
        <button
          type="button"
          className="grid size-10 shrink-0 place-items-center rounded-full border border-kinari-50/60 bg-kinari-50/10 text-kinari-50 hover:bg-kinari-50/25"
          aria-label={t.itinerary.closePanel}
          title={t.itinerary.closePanel}
          onClick={() => actions.setDrawer(false)}
        >
          <X className="size-5" />
        </button>
      </div>
      <div
        role="tablist"
        aria-label={t.itinerary.panelLabel}
        className="flex shrink-0 gap-2 px-3 pt-3 pb-2"
        onKeyDown={onKeyDown}
      >
        {PANEL_TABS.map((id) => {
          const selected = tab === id;
          const Icon = TAB_ICON[id];
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
              className={`flex min-h-12 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border-2 px-2 py-1.5 font-bold text-base leading-tight transition ${
                selected
                  ? "border-yamabuki-400 bg-yamabuki-400 text-ink shadow-soft"
                  : "border-line-strong bg-white/80 text-ink hover:bg-white"
              }`}
            >
              <Icon aria-hidden="true" className="size-5 shrink-0" />
              {t.itinerary.tabs[id]}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        {tab === "itinerary" ? <ItineraryTab /> : null}
        {tab === "map" ? <GuideTab /> : null}
        {tab === "sources" ? <ConfirmTab /> : null}
      </div>
    </section>
  );
}
