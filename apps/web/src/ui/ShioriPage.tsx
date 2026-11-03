import {
  type Etiquette,
  type Festival,
  type Itinerary,
  itineraryItems,
  mainFestivalDay,
  type Source,
  UNKNOWN,
} from "@matsuri-ikoka/schema";
import {
  Fragment,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatDate, formatDateTime, MESSAGES, type Messages } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { mainFestival, shioriReady, usedSources } from "../state/selectors";
import { buttonPrimary, buttonSecondary, ConfidenceBadge, PrintedUrl, timeRange } from "./common";
import { weatherText } from "./ItineraryPanel";
import { shioriShareUrl, sourceLabel } from "./links";
import { FestivalStamp } from "./Waiting";

// 旅のしおり。A4 縦 1〜2 枚に収まる紙面で、印刷しても読める。
// 表紙 → 今日の主役 → 1日の流れ → 地図 → 地元の味 → はじめての方へ → 雨の日の案 → 出典

const MapView = lazy(() => import("./MapView"));

function Section({
  id,
  title,
  children,
  className = "",
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={`shiori-${id}`}
      className={`print-avoid-break border-wood-300 border-t-2 pt-3 print:pt-1.5 ${className}`}
      data-testid={`shiori-${id}`}
    >
      <h2
        id={`shiori-${id}`}
        className="mb-2 font-bold text-ai-800 text-lg print:mb-1 print:text-[11pt]"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** 祭りのデータと旅程・再確認の出典を、URL の重複を除いて集める */
function shioriSources(base: readonly Source[], festival: Festival | null): Source[] {
  const all = [...base];
  if (festival !== null) {
    all.push(
      ...festival.sources,
      ...festival.occurrences.flatMap((occurrence) => occurrence.sources),
      ...festival.etiquette.sources,
      ...festival.access.sources,
      ...festival.food.local.flatMap((food) => food.sources),
      ...festival.trivia.map((trivia) => trivia.source),
    );
  }
  const byUrl = new Map<string, Source>();
  for (const source of all) {
    if (!byUrl.has(source.url)) {
      byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
}

// ---------------------------------------------------------------------------
// はじめての方へ（日本語と英語の両方で出す）

type EtiquetteRow = {
  key: keyof Messages["etiquette"]["labels"];
  ja: ReactNode;
  en: ReactNode;
};

function list(items: readonly string[]): ReactNode {
  return (
    <ul className="list-disc pl-4">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function etiquetteRows(etiquette: Etiquette): EtiquetteRow[] {
  const ja = MESSAGES.ja.etiquette;
  const en = MESSAGES.en.etiquette;
  const jaOnly = <span className="text-ink-soft text-xs">{en.noTranslation}</span>;
  const textRow = (
    key: EtiquetteRow["key"],
    value: string | readonly string[] | typeof UNKNOWN | null,
  ): EtiquetteRow | null => {
    if (value === null) {
      return null;
    }
    if (value === UNKNOWN) {
      return { key, ja: ja.unknown, en: en.unknown };
    }
    return { key, ja: typeof value === "string" ? value : list(value), en: jaOnly };
  };
  const rows: (EtiquetteRow | null)[] = [
    etiquette.participation === UNKNOWN
      ? { key: "participation", ja: ja.unknown, en: en.unknown }
      : {
          key: "participation",
          ja: ja.participation[etiquette.participation],
          en: en.participation[etiquette.participation],
        },
    textRow("howToJoin", etiquette.howToJoin),
    textRow("rules", etiquette.rules),
    textRow("dress", etiquette.dress),
    textRow("bring", etiquette.bring),
    etiquette.risk === UNKNOWN
      ? { key: "risk", ja: ja.unknown, en: en.unknown }
      : {
          key: "risk",
          ja: `${ja.risk[etiquette.risk.level]}：${etiquette.risk.reason}`,
          en: (
            <>
              {en.risk[etiquette.risk.level]}. {jaOnly}
            </>
          ),
        },
    etiquette.photo === UNKNOWN
      ? { key: "photo", ja: ja.unknown, en: en.unknown }
      : {
          key: "photo",
          ja: `${ja.photo[etiquette.photo.policy]}${etiquette.photo.note ? `：${etiquette.photo.note}` : ""}`,
          en: (
            <>
              {en.photo[etiquette.photo.policy]}
              {etiquette.photo.note ? <>. {jaOnly}</> : null}
            </>
          ),
        },
  ];
  return rows.filter((row): row is EtiquetteRow => row !== null);
}

function FirstTime({ festival, itinerary }: { festival: Festival; itinerary: Itinerary }) {
  const ja = MESSAGES.ja;
  const en = MESSAGES.en;
  const { etiquette, access } = festival;
  const occurrence =
    festival.occurrences.find((o) => o.date === mainFestivalDay(itinerary).date) ??
    festival.occurrences[0];
  const items = itineraryItems(itinerary);
  const mainIndex = items.findIndex(
    (item) => item.type === "festival" && item.festivalId === itinerary.mainFestivalId,
  );
  const homeward = items.slice(mainIndex + 1).find((item) => item.type === "move");
  const asks = [
    ...(etiquette.rules === UNKNOWN ? [] : etiquette.rules),
    ...(etiquette.photo !== UNKNOWN && etiquette.photo.note ? [etiquette.photo.note] : []),
  ];
  const cautions: { key: string; ja: string; en: string }[] = [
    ...itinerary.notes.map((note) => ({ key: note, ja: note, en: en.etiquette.noTranslation })),
    {
      key: "parking",
      ja: ja.shiori.parking[access.parking],
      en: en.shiori.parking[access.parking],
    },
    ...access.trafficRestrictions.map((text) => ({
      key: text,
      ja: text,
      en: en.etiquette.noTranslation,
    })),
    ...(occurrence?.rainPolicy
      ? [
          {
            key: "rain",
            ja: `${ja.shiori.rainPolicy}：${occurrence.rainPolicy}`,
            en: `${en.shiori.rainPolicy}: ${en.etiquette.noTranslation}`,
          },
        ]
      : []),
    ...(homeward
      ? [
          {
            key: "homeward",
            ja: `${ja.shiori.homeward}：${homeward.reason}`,
            en: `${en.shiori.homeward}: ${en.etiquette.noTranslation}`,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm">
        {ja.etiquette.lead}
        <br />
        <span lang="en">{en.etiquette.lead}</span>
      </p>
      {asks.length > 0 ? (
        <div className="rounded-xl border-2 border-shu-600 bg-shu-500/5 px-3 py-2">
          <p className="font-bold text-shu-700">
            {ja.etiquette.ask} / <span lang="en">{en.etiquette.ask}</span>
          </p>
          <ul className="mt-1 list-disc pl-5 font-semibold">
            {asks.map((ask) => (
              <li key={ask}>{ask}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <table className="w-full border-collapse text-sm" data-testid="etiquette-table">
        <thead className="sr-only">
          <tr>
            <th scope="col">項目 / Item</th>
            <th scope="col">日本語</th>
            <th scope="col">English</th>
          </tr>
        </thead>
        <tbody>
          {etiquetteRows(etiquette).map((row) => (
            <tr key={row.key} className="border-kinari-300 border-b align-top">
              <th scope="row" className="w-[22%] py-1.5 pr-2 text-left font-bold text-ink">
                {ja.etiquette.labels[row.key]}
                <span lang="en" className="block font-semibold text-ink-soft text-xs">
                  {en.etiquette.labels[row.key]}
                </span>
              </th>
              <td className="py-1.5 pr-2">{row.ja}</td>
              <td lang="en" className="w-[34%] py-1.5">
                {row.en}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <h3 className="font-bold text-ai-700 text-sm">
          {ja.shiori.cautions} / <span lang="en">{en.shiori.cautions}</span>
        </h3>
        <p className="text-ink-soft text-xs">
          {ja.etiquette.jaOnlyNote}
          <span lang="en" className="block">
            {en.etiquette.jaOnlyNote}
          </span>
        </p>
        <ul className="mt-1 space-y-1 text-sm">
          {cautions.map((caution) => (
            <li key={caution.key} className="grid gap-x-3 sm:grid-cols-[1fr_34%]">
              <span>・{caution.ja}</span>
              <span lang="en" className="text-ink-soft text-xs">
                {caution.en}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

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
      className="w-full rounded-xl bg-kinari-50 px-3 py-2 text-ink text-sm"
      data-testid="shiori-share"
    >
      <p className="font-bold">{t.shiori.share}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all font-medium text-ai-700 underline underline-offset-2"
        >
          {url}
        </a>
        <button type="button" className={buttonSecondary} onClick={() => void copy()}>
          {copied ? t.shiori.copied : t.shiori.copy}
        </button>
      </div>
      <p className="mt-1 text-ink-soft text-xs">{t.shiori.shareNote}</p>
    </div>
  );
}

export function ShioriPage() {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const itinerary = useApp((state) => state.itinerary.current);
  const verify = useApp((state) => state.verify);
  const stamps = useApp((state) => state.stamps);
  const festival = useApp(mainFestival);
  const loadState = useApp((state) =>
    state.itinerary.current === null
      ? undefined
      : state.festivalLoad[state.itinerary.current.mainFestivalId],
  );
  const baseSources = useApp(usedSources);
  const sources = useMemo(() => shioriSources(baseSources, festival), [baseSources, festival]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const transport = useApp((state) => state.transport);
  const ready = useApp(shioriReady);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  if (itinerary === null) {
    return null;
  }
  const festivalDay = mainFestivalDay(itinerary);
  const mainItem = festivalDay.items.find(
    (item) => item.type === "festival" && item.festivalId === itinerary.mainFestivalId,
  );
  const occurrence =
    festival?.occurrences.find((o) => o.date === festivalDay.date) ?? festival?.occurrences[0];
  const meals = itineraryItems(itinerary).filter((item) => item.type === "meal");
  const verified = verify.result === "as_planned";
  const party = t.conditions.party(itinerary.party.adults, itinerary.party.children);
  const shareUrl = ready ? shioriShareUrl(transport, itinerary.id, window.location.origin) : null;

  return (
    <div className="min-h-dvh bg-wood-800 py-4 print:bg-white print:py-0" data-testid="shiori">
      <div className="no-print mx-auto mb-3 flex max-w-[210mm] flex-wrap justify-between gap-2 px-3">
        <button
          type="button"
          className={`${buttonSecondary} bg-kinari-50`}
          onClick={actions.closeShiori}
        >
          {t.shiori.close}
        </button>
        <button type="button" className={buttonPrimary} onClick={() => window.print()}>
          {t.shiori.print}
        </button>
        {shareUrl === null ? null : <ShareBox url={shareUrl} />}
      </div>

      <article
        aria-labelledby="shiori-title"
        className="mx-auto max-w-[210mm] space-y-4 bg-kinari-50 px-5 py-6 text-ink shadow-2xl sm:px-10 print:max-w-none print:space-y-3 print:bg-white print:p-0 print:shadow-none"
      >
        {/* 1. 表紙 */}
        <header
          className="print-avoid-break flex items-start justify-between gap-4"
          data-testid="shiori-cover"
        >
          <div className="min-w-0">
            <p className="font-bold text-shu-700 tracking-widest">{t.shiori.title}</p>
            <h1
              id="shiori-title"
              ref={headingRef}
              tabIndex={-1}
              className="mt-1 font-bold text-3xl leading-tight print:text-[20pt]"
            >
              {itinerary.title}
            </h1>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
              <dt className="font-bold">{t.shiori.date}</dt>
              <dd>{formatDate(festivalDay.date, locale)}</dd>
              <dt className="font-bold">{t.shiori.party}</dt>
              <dd>{party}</dd>
              <dt className="font-bold">{t.shiori.weather}</dt>
              <dd>{weatherText(t, festivalDay.weather)}</dd>
            </dl>
          </div>
          <div className="shrink-0 text-center">
            {verified ? (
              <FestivalStamp name={festival?.name.ja ?? mainItem?.name ?? null} size="lg" />
            ) : null}
            {stamps > 0 ? (
              <p className="mt-1 font-semibold text-shu-700 text-xs">
                {t.shiori.stamps}：{"◉".repeat(Math.min(stamps, 6))}
              </p>
            ) : null}
          </div>
        </header>

        {/* 2. 今日の主役 */}
        <Section id="main" title={t.shiori.sections.main}>
          {festival === null ? (
            <p className="text-ink-soft">
              {loadState === "loading" ? "…" : t.shiori.festivalLoading}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 print:grid-cols-2">
              <div>
                <p className="font-bold text-xl">
                  {festival.name.ja}
                  {festival.name.en ? (
                    <span lang="en" className="ml-2 font-semibold text-ink-soft text-sm">
                      {festival.name.en}
                    </span>
                  ) : null}
                </p>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                  <dt className="font-bold">{t.shiori.when}</dt>
                  <dd>
                    {formatDate(festivalDay.date, locale)}{" "}
                    {mainItem ? timeRange(mainItem.start, mainItem.end) : null}
                  </dd>
                  <dt className="font-bold">{t.shiori.where}</dt>
                  <dd>
                    {festival.venue.name}（
                    {festival.municipalities.map((m) => `${m.prefecture}${m.name}`).join("・")}）
                  </dd>
                  <dt className="font-bold">{t.shiori.scale}</dt>
                  <dd>
                    {t.shiori.scales[festival.scaleTier]}・{t.categories[festival.category]}
                  </dd>
                  {occurrence?.rainPolicy ? (
                    <>
                      <dt className="font-bold">{t.shiori.rainPolicy}</dt>
                      <dd>{occurrence.rainPolicy}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
              <div className="text-sm">
                <h3 className="font-bold text-ai-700">{t.shiori.highlights}</h3>
                <ol className="list-decimal pl-5">
                  {festival.highlights.slice(0, 3).map((highlight) => (
                    <li key={highlight}>{highlight}</li>
                  ))}
                </ol>
                {festival.trivia.length > 0 ? (
                  <>
                    <h3 className="mt-1 font-bold text-ai-700">{t.shiori.background}</h3>
                    <ul className="list-disc pl-5">
                      {festival.trivia.slice(0, 2).map((trivia) => (
                        <li key={trivia.text}>{trivia.text}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </div>
          )}
        </Section>

        {/* 3. 1日の流れ */}
        <Section id="flow" title={t.shiori.sections.flow}>
          <ol className="space-y-1.5 text-sm">
            {itinerary.days.map((day, index) => (
              <Fragment key={day.date}>
                {itinerary.days.length > 1 ? (
                  <li className="pt-1 font-bold">
                    {t.itinerary.day(index + 1, formatDate(day.date, locale))}
                    <span className="ml-2 font-normal text-ink-soft">
                      {t.shiori.weather}：{weatherText(t, day.weather)}
                    </span>
                  </li>
                ) : null}
                {day.items.map((item) => (
                  <li
                    key={item.id}
                    className="grid grid-cols-[6.5rem_1fr] gap-x-2 print:grid-cols-[7rem_1fr]"
                  >
                    <span className="font-bold font-mono tabular-nums">
                      {item.start}〜{item.end}
                    </span>
                    <span>
                      <span className="font-bold">{item.name}</span>
                      <span className="ml-1 text-ink-soft text-xs">
                        {item.move === null
                          ? null
                          : t.itinerary.move(
                              t.itinerary.means[item.move.means],
                              item.move.minutes[0],
                              item.move.minutes[1],
                            )}
                      </span>
                      <span className="block text-ink">{item.reason}</span>
                    </span>
                  </li>
                ))}
                {day.stay === null ? null : (
                  <li className="text-ink-soft">{t.itinerary.stay(day.stay.area)}</li>
                )}
              </Fragment>
            ))}
          </ol>
        </Section>

        {/* 4. 地図 と 5. 地元の味 */}
        <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
          <Section id="map" title={t.shiori.sections.map}>
            <Suspense fallback={null}>
              <MapView interactive={false} heightClass="h-56 print:h-[46mm]" />
            </Suspense>
            {festival === null ? null : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 px-3 text-sm">
                <dt className="font-bold">{t.map.venue}</dt>
                <dd>{festival.venue.name}</dd>
                <dt className="font-bold">{t.shiori.stations}</dt>
                <dd>
                  {festival.access.stations
                    .map((s) => `${s.name}（${t.shiori.walk(s.walkMinutes[0], s.walkMinutes[1])}）`)
                    .join("、") || t.etiquette.unknown}
                </dd>
                <dt className="font-bold">{t.shiori.toilets}</dt>
                <dd>{t.shiori.toiletsUnknown}</dd>
              </dl>
            )}
          </Section>
          <Section id="food" title={t.shiori.sections.food}>
            {festival === null ? null : (
              <p className="font-semibold text-sm">{t.shiori.stalls[festival.food.stalls]}</p>
            )}
            {festival !== null && festival.food.local.length > 0 ? (
              <>
                <h3 className="mt-1 font-bold text-ai-700 text-sm">{t.shiori.localFood}</h3>
                <ul className="list-disc pl-5 text-sm">
                  {festival.food.local.map((food) => (
                    <li key={food.name}>
                      <span className="font-semibold">{food.name}</span>
                      {food.note ? `：${food.note}` : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {meals.length > 0 ? (
              <>
                <h3 className="mt-1 font-bold text-ai-700 text-sm">{t.shiori.mealsInPlan}</h3>
                <ul className="list-disc pl-5 text-sm">
                  {meals.map((meal) => (
                    <li key={meal.id}>
                      {meal.start} {meal.name}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Section>
        </div>

        {/* 6. はじめての方へ（日本語と英語） */}
        <Section
          id="first-time"
          title={
            <>
              {MESSAGES.ja.etiquette.heading} /{" "}
              <span lang="en">{MESSAGES.en.etiquette.heading}</span>
            </>
          }
        >
          {festival === null ? (
            <p className="text-ink-soft">{t.shiori.festivalLoading}</p>
          ) : (
            <FirstTime festival={festival} itinerary={itinerary} />
          )}
        </Section>

        {/* 7. 雨の日の案 と 8. 出典 */}
        <Section id="rain" title={t.shiori.sections.rain}>
          {itinerary.alternatives.length === 0 ? (
            <p className="text-ink-soft text-sm">{t.shiori.noAlternatives}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {itinerary.alternatives.map((alternative) => (
                <li key={alternative.summary}>
                  <span className="font-bold">{t.itinerary.altKinds[alternative.kind]}：</span>
                  {alternative.summary}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="sources" title={t.shiori.sections.sources}>
          {verified && verify.checkedAt !== null ? (
            <p className="font-semibold text-emerald-800 text-sm">
              {t.shiori.verified(formatDateTime(verify.checkedAt, locale))}
            </p>
          ) : null}
          <ul className="mt-1 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2 print:grid-cols-2">
            {sources.map((source) => (
              <li key={source.url} className="flex flex-wrap items-center gap-x-1.5">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all underline"
                >
                  {sourceLabel(source)}
                </a>
                <PrintedUrl source={source} />
                <span className="text-ink-soft">{source.checkedAt}</span>
                <ConfidenceBadge confidence={source.confidence} />
              </li>
            ))}
          </ul>
          <p className="mt-2 font-bold text-sm">{t.shiori.finalCheck}</p>
          {shareUrl === null ? null : (
            <p className="mt-1 break-all text-xs" data-testid="shiori-share-printed">
              {t.shiori.share}：{shareUrl}
            </p>
          )}
        </Section>
      </article>
    </div>
  );
}
