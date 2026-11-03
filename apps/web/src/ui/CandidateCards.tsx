import type { Festival, FestivalCandidate } from "@matsuri-ikoka/schema";
import { Check, ChevronDown, MapPin, Star, Users, UtensilsCrossed } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Messages } from "../i18n";
import { formatDate } from "../i18n";
import {
  candidateArea,
  candidateMonth,
  candidateTags,
  candidateTheme,
  filterCandidates,
  filterOptions,
  NO_FILTERS,
  type PostcardFilters,
} from "../state/postcards";
import { useActions, useApp, useT } from "../state/react";
import { type FitReason, fitReasons } from "../state/reasons";
import { ConfidenceBadge, Pill, SourceLink, timeRange } from "./common";
import { CATEGORY_ICON, CATEGORY_TONE, LanternIcon } from "./icons";
import { issueUrl } from "./links";
import { Portrait } from "./Portraits";

// 祭りの候補（最大3枚）を、絵葉書のようなカードで並べる。表は、祭りの種類の色と紋の図柄・名前・場所・日時・
// ひとこと・目印のタグ。「詳細を見る」で、おすすめポイント・合う理由・「ここでしか」・祭りの特徴を開く。
// 出典と訂正の窓口はいつも見せる。写真は使わず、色と図柄で絵葉書らしくする。
// どれも祭りのデータと候補の項目から出し、その場で文章を作らない。選ぶと旅程を組み始める。

function reasonText(t: Messages, reason: FitReason): string {
  switch (reason.kind) {
    case "onWishDay":
      return t.candidates.reasons.onWishDay;
    case "fromOrigin":
      return t.candidates.reasons.fromOrigin(reason.hub, reason.min, reason.max);
    case "local":
      return t.candidates.reasons.local;
    case "regional":
      return t.candidates.reasons.regional;
    case "canJoin":
      return t.candidates.reasons.canJoin;
  }
}

const SCALE_LEVEL = { XS: 1, S: 2, M: 3, L: 4 } as const;
const HIDDEN_LEVEL = { local: 3, regional: 2, major: 1 } as const;

/** 段のメーター（値は文字でも出す） */
function Meter({ level, max }: { level: number; max: number }) {
  return (
    <span aria-hidden="true" className="flex gap-0.5">
      {Array.from({ length: max }, (_, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: メーターの目盛りは位置そのもの
          key={index}
          className={`h-2.5 w-2.5 rounded-sm ${index < level ? "bg-yamabuki-400" : "bg-kinari-300"}`}
        />
      ))}
    </span>
  );
}

function Stat({ label, value, meter }: { label: string; value: string; meter?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-white/70 px-2 py-1">
      <dt className="whitespace-nowrap font-bold text-ink-soft text-xs">{label}</dt>
      <dd className="flex items-center gap-1.5 whitespace-nowrap font-bold text-ink text-sm">
        {meter}
        {value}
      </dd>
    </div>
  );
}

/** 祭りの特徴。祭りのデータがまだ届いていなければ出さない */
function Features({ festival }: { festival: Festival }) {
  const t = useT();
  const participation = festival.etiquette.participation;
  const localFood = festival.food.local[0]?.name ?? t.festivalCard.none;
  return (
    <section aria-label={t.festivalCard.features}>
      <h4 className="mb-1 font-bold text-ai-700 text-xs">{t.festivalCard.features}</h4>
      <dl className="grid grid-cols-2 gap-1">
        <Stat
          label={t.festivalCard.stats.scale}
          value={t.festivalCard.scale[festival.scaleTier]}
          meter={<Meter level={SCALE_LEVEL[festival.scaleTier]} max={4} />}
        />
        <Stat
          label={t.festivalCard.stats.hidden}
          value={t.festivalCard.hidden[festival.popularity]}
          meter={<Meter level={HIDDEN_LEVEL[festival.popularity]} max={3} />}
        />
        <Stat
          label={t.festivalCard.stats.join}
          value={t.festivalCard.join[participation]}
          meter={<Users aria-hidden="true" className="size-3.5 text-ai-600" />}
        />
        <Stat
          label={t.festivalCard.stats.stalls}
          value={t.festivalCard.stalls[festival.food.stalls]}
        />
        <div className="col-span-2">
          <Stat
            label={t.festivalCard.stats.food}
            value={localFood}
            meter={<UtensilsCrossed aria-hidden="true" className="size-3.5 text-shu-600" />}
          />
        </div>
      </dl>
    </section>
  );
}

function Card({
  candidate,
  festival,
  index,
}: {
  candidate: FestivalCandidate;
  festival: Festival | null;
  index: number;
}) {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const conditions = useApp((state) => state.session.conditions);
  const preferences = useApp((state) => state.preferences);
  const streaming = useApp((state) => state.session.streaming);
  const [open, setOpen] = useState(false);
  const reasons = fitReasons(candidate, festival, conditions, preferences);
  const tags = candidateTags(candidate, festival);
  const onlyHere = festival?.trivia[0] ?? null;
  const time = timeRange(candidate.start, candidate.end);
  const headingId = `candidate-${candidate.festivalId}`;
  const detailsId = `candidate-details-${candidate.festivalId}`;
  const issueName = `${candidate.name}（${candidate.festivalId}）`;
  const category = festival?.category ?? "other";
  const Emblem = festival === null ? LanternIcon : (CATEGORY_ICON[category] ?? LanternIcon);
  const tone = CATEGORY_TONE[category] ?? CATEGORY_TONE.other;
  const highlights = festival?.highlights.slice(0, 3) ?? [candidate.highlight];

  return (
    <article
      aria-labelledby={headingId}
      className="washi flex w-full animate-pop flex-col overflow-hidden rounded-card border border-line-strong p-2 shadow-lift md:w-[22rem]"
      style={{ animationDelay: `${index * 120}ms` }}
      data-testid="candidate-card"
    >
      {/* 絵葉書の絵の面：種類の色と紋の図柄 */}
      <div
        className={`relative overflow-hidden rounded-[0.7rem] bg-gradient-to-br ${tone} px-4 pt-4 pb-3 text-kinari-50`}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 bg-[length:24px_14px] bg-[radial-gradient(circle_at_50%_100%,transparent_9px,rgb(255_255_255/0.12)_10px,transparent_12px)] opacity-80"
        />
        <span aria-hidden="true" className="-right-4 -bottom-6 absolute text-kinari-50/20">
          <Emblem className="size-32" />
        </span>
        {/* 切手のような札：希望日からのずれ */}
        <span
          className={`absolute top-2.5 right-2.5 rotate-3 rounded-sm border-2 border-dashed px-1.5 py-0.5 font-black text-xs ${
            candidate.daysFromWish === 0
              ? "border-ink/40 bg-yamabuki-400 text-ink"
              : "border-ink/30 bg-kinari-50 text-ink"
          }`}
        >
          {t.candidates.daysFromWish(candidate.daysFromWish)}
        </span>
        <div className="relative pr-20">
          {festival === null ? null : (
            <p className="font-bold text-kinari-100 text-xs">{t.categories[category]}</p>
          )}
          <h3 id={headingId} className="font-bold text-2xl leading-tight drop-shadow">
            {candidate.name}
          </h3>
          <p className="mt-1 flex items-center gap-1 text-kinari-100 text-sm">
            <MapPin aria-hidden="true" className="size-3.5 shrink-0" />
            {candidate.venueName}・{candidate.place}
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 px-2 pt-2.5 pb-1">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <p className="font-bold text-ink text-lg">
            {formatDate(candidate.date, locale)}
            <span className="ml-2">{time ?? t.candidates.timeUnknown}</span>
          </p>
          <span className="flex flex-wrap gap-1">
            <ConfidenceBadge confidence={candidate.confidence} />
            {candidate.confirmed ? null : <Pill tone="shu">{t.candidates.unconfirmed}</Pill>}
          </span>
        </div>
        <p className="font-medium text-ink text-sm">{candidate.highlight}</p>
        {tags.length > 0 ? (
          <ul className="flex flex-wrap gap-1" aria-label={t.festivalCard.features}>
            {tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full border border-line-strong bg-white/80 px-2 py-0.5 font-bold text-ink-soft text-xs"
              >
                {t.candidates.tags[tag]}
              </li>
            ))}
          </ul>
        ) : null}
        {candidate.confirmed ? null : (
          <p className="rounded-lg bg-shu-500/10 px-2 py-1 font-medium text-shu-700 text-sm">
            {t.candidates.unconfirmedNote}
          </p>
        )}

        <button
          type="button"
          className="flex items-center gap-1 self-start rounded-full px-1 font-bold text-ai-700 text-sm underline-offset-2 hover:underline"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
        >
          {open ? t.candidates.hideDetails : t.candidates.details}
          <ChevronDown
            aria-hidden="true"
            className={`size-4 transition ${open ? "rotate-180" : ""}`}
          />
        </button>
        <div id={detailsId} hidden={!open} className="space-y-3">
          <section aria-label={t.festivalCard.recommend}>
            <h4 className="mb-1 font-bold text-ai-700 text-xs">{t.festivalCard.recommend}</h4>
            <ul className="space-y-1">
              {highlights.map((highlight) => (
                <li key={highlight} className="flex items-start gap-1.5 font-bold text-ink text-sm">
                  <Star
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 fill-yamabuki-400 text-yamabuki-400"
                  />
                  {highlight}
                </li>
              ))}
            </ul>
            {reasons.length > 0 ? (
              <ul className="mt-1.5 space-y-0.5" aria-label={t.candidates.whyFits}>
                {reasons.map((reason) => (
                  <li key={reason.kind} className="flex items-start gap-1.5 text-ink text-sm">
                    <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-700" />
                    {reasonText(t, reason)}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {onlyHere === null ? null : (
            <section
              aria-label={t.candidates.onlyHere}
              className="rounded-card border border-line-strong border-dashed bg-white/60 px-3 py-2"
            >
              <h4 className="font-bold text-shu-700 text-xs">{t.candidates.onlyHere}</h4>
              <p className="font-medium text-ink text-sm">{onlyHere.text}</p>
              <SourceLink source={onlyHere.source} compact />
            </section>
          )}

          {festival === null ? (
            <p className="text-ink-soft text-xs">{t.festivalCard.loading}</p>
          ) : (
            <Features festival={festival} />
          )}
        </div>

        <div className="text-xs">
          <span className="mr-1 font-bold text-ai-700">{t.candidates.source}</span>
          <SourceLink source={candidate.source} />
        </div>

        <div className="mt-auto">
          <button
            type="button"
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border-2 border-wood-700/30 bg-yamabuki-400 px-4 font-black text-ink text-lg shadow-soft transition hover:brightness-105 disabled:cursor-not-allowed disabled:bg-stone-300"
            disabled={streaming}
            onClick={() => void actions.chooseCandidate(candidate)}
          >
            {t.candidates.choose}
          </button>
          <div className="mt-2 flex flex-wrap gap-x-3 text-xs">
            <a
              className="text-ink-soft underline underline-offset-2"
              href={issueUrl(
                "festival-correction.yml",
                t.issues.correctionTitle(candidate.name),
                issueName,
              )}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.candidates.correction}
            </a>
            <a
              className="text-ink-soft underline underline-offset-2"
              href={issueUrl(
                "festival-opt-out.yml",
                t.issues.optOutTitle(candidate.name),
                issueName,
              )}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.candidates.optOut}
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

const filterChip =
  "inline-flex min-h-8 items-center gap-1 whitespace-nowrap rounded-full border px-3 font-bold text-xs transition sm:text-sm";

function FilterGroup<T extends string | number>({
  label,
  options,
  value,
  text,
  onChange,
}: {
  label: string;
  options: { value: T; count: number }[];
  value: T | null;
  text: (value: T) => string;
  onChange: (value: T | null) => void;
}) {
  const t = useT();
  const chip = (selected: boolean) =>
    `${filterChip} ${
      selected
        ? "border-yamabuki-400 bg-yamabuki-400 text-ink"
        : "border-line-strong bg-white/80 text-ink-soft hover:bg-white"
    }`;
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="mr-1 font-bold text-ink text-xs">
        {label}
      </span>
      <button
        type="button"
        aria-pressed={value === null}
        className={chip(value === null)}
        onClick={() => onChange(null)}
      >
        {t.candidates.filters.all}
      </button>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={value === option.value}
          className={chip(value === option.value)}
          onClick={() => onChange(value === option.value ? null : option.value)}
        >
          {text(option.value)}
          <span className="font-normal opacity-70">{option.count}</span>
        </button>
      ))}
    </fieldset>
  );
}

/** エリア・時期・テーマの絞り込み。候補が2つ以上あるときだけ出す */
function Filters({
  filters,
  onChange,
}: {
  filters: PostcardFilters;
  onChange: (filters: PostcardFilters) => void;
}) {
  const t = useT();
  const candidates = useApp((state) => state.candidates);
  const festivals = useApp((state) => state.festivals);
  const areas = useMemo(
    () => filterOptions(candidates, (candidate) => candidateArea(candidate.place)),
    [candidates],
  );
  const months = useMemo(
    () => filterOptions(candidates, (candidate) => candidateMonth(candidate.date)),
    [candidates],
  );
  const themes = useMemo(
    () =>
      filterOptions(candidates, (candidate) =>
        candidateTheme(festivals[candidate.festivalId] ?? null),
      ),
    [candidates, festivals],
  );
  return (
    <section
      aria-label={t.candidates.filters.label}
      className="washi flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line-strong px-3 py-2 shadow-soft"
      data-testid="candidate-filters"
    >
      <FilterGroup
        label={t.candidates.filters.area}
        options={areas}
        value={filters.area}
        text={(value) => value}
        onChange={(area) => onChange({ ...filters, area })}
      />
      <FilterGroup
        label={t.candidates.filters.month}
        options={months}
        value={filters.month}
        text={(value) => t.candidates.filters.monthName(value)}
        onChange={(month) => onChange({ ...filters, month })}
      />
      <FilterGroup
        label={t.candidates.filters.theme}
        options={themes}
        value={filters.theme}
        text={(value) => (t.categories as Record<string, string>)[value] ?? value}
        onChange={(theme) => onChange({ ...filters, theme })}
      />
      <button
        type="button"
        className="ml-auto text-ink-soft text-xs underline underline-offset-2"
        onClick={() => onChange(NO_FILTERS)}
      >
        {t.candidates.filters.reset}
      </button>
    </section>
  );
}

export function CandidateCards() {
  const t = useT();
  const actions = useActions();
  const open = useApp((state) => state.ui.candidatesOpen);
  const candidates = useApp((state) => state.candidates);
  const festivals = useApp((state) => state.festivals);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [filters, setFilters] = useState<PostcardFilters>(NO_FILTERS);

  useEffect(() => {
    if (open) {
      headingRef.current?.focus();
    }
  }, [open]);
  // 候補が入れ替わったら、絞り込みを戻す
  // biome-ignore lint/correctness/useExhaustiveDependencies: 候補が変わったときだけ戻す
  useEffect(() => setFilters(NO_FILTERS), [candidates]);

  if (!open || candidates.length === 0) {
    return null;
  }
  const shown = filterCandidates(candidates, festivals, filters);
  const first = candidates[0];
  // コンシェルジュのひとこと（1行）。くわしいことはカードに書く
  const line =
    candidates.length === 1 && first !== undefined
      ? t.candidates.found(candidateArea(first.place))
      : t.candidates.foundMany(candidates.length);
  return (
    <section
      aria-labelledby="candidates-title"
      className="fixed inset-0 z-40 overflow-y-auto bg-wood-900/55 p-3 backdrop-blur-[3px] sm:p-6"
      data-testid="candidates"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          actions.setCandidatesOpen(false);
        }
      }}
    >
      <div className="mx-auto mb-3 flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <Portrait speaker="concierge" className="size-14" />
          <div className="min-w-0">
            <h2
              id="candidates-title"
              ref={headingRef}
              tabIndex={-1}
              className="flex items-center gap-2 font-black text-kinari-50 text-xl drop-shadow"
            >
              <LanternIcon className="size-6 text-yamabuki-400" />
              {t.candidates.title}
              <span className="rounded-full bg-kinari-50/90 px-2 py-0.5 font-bold text-ink text-xs">
                {t.candidates.filters.count(shown.length)}
              </span>
            </h2>
            <p className="font-bold text-kinari-100 text-sm" data-testid="candidates-line">
              {line}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="hud-chip min-h-10 rounded-full px-4 font-bold"
          onClick={() => actions.setCandidatesOpen(false)}
        >
          {t.candidates.close}
        </button>
      </div>
      {candidates.length > 1 ? (
        <div className="mx-auto mb-4 max-w-6xl">
          <Filters filters={filters} onChange={setFilters} />
        </div>
      ) : null}
      <div className="mx-auto flex max-w-6xl flex-wrap items-stretch justify-center gap-4">
        {shown.length === 0 ? (
          <p className="washi rounded-card px-4 py-3 font-bold text-ink">
            {t.candidates.filters.none}
          </p>
        ) : (
          shown.map((candidate, index) => (
            <Card
              key={candidate.festivalId}
              candidate={candidate}
              festival={festivals[candidate.festivalId] ?? null}
              index={index}
            />
          ))
        )}
      </div>
    </section>
  );
}
