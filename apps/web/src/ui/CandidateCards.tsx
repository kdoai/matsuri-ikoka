import type { Festival, FestivalCandidate, SearchMiss, SearchOutcome } from "@matsuri-ikoka/schema";
import {
  Baby,
  BookOpen,
  CalendarCheck,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Funnel,
  Gem,
  LayoutGrid,
  List,
  LoaderCircle,
  type LucideIcon,
  MapPin,
  Moon,
  RotateCcw,
  Star,
  Store,
  TrainFront,
  Users,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Messages } from "../i18n";
import { formatDate } from "../i18n";
import { hasNextSteps } from "../state/events";
import {
  candidateArea,
  candidateMonth,
  candidateTags,
  candidateTheme,
  filterCandidates,
  filterOptions,
  NO_FILTERS,
  type PostcardFilters,
  type PostcardTag,
} from "../state/postcards";
import { useActions, useApp, useT } from "../state/react";
import { type FitReason, fitReasons } from "../state/reasons";
import { FestivalBand, ThemeArt } from "./candidates/Art";
import { type CandidateView, chooseBlock, faceTags, needsCheck } from "./candidates/view";
import { ConfidenceBadge, Pill, SourceLink, timeRange } from "./common";
import { LanternIcon } from "./icons";
import { issueUrl } from "./links";
import { Portrait } from "./Portraits";
import { loadCandidateView, saveCandidateView } from "./storage";

// 祭りの候補を、カード表示とリスト表示で並べる（選んだ表示はこの端末に覚えておく）。
// カードは横長で、種類の絵・名前・ご希望の日との関係・場所・日時・確度・目印のタグ・「この祭りにする」「詳細を見る」。
// リストは1行に名前・日時・場所・確度をまとめ、多くの候補を見比べられるようにする。
// 「詳細を見る」で、おすすめポイント・合う理由・「ここでしか」・祭りの特徴・出典を開く。
// 開催が確認できていない祭りは選べず、理由を文字で出す。写真は使わず、自分たちで描いた絵にする。
// どれも祭りのデータと候補の項目から出し、その場で文章を作らない。選ぶと旅程を組み始める。
// 条件に合う祭りがなければ「見つかりませんでした」と出し、条件を1つだけ外せば出る祭り（外れている点つき）と、
// 次の手のボタン（押すと変えた条件で探し直す）を並べる。

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

const TAG_ICON: Record<PostcardTag, LucideIcon> = {
  wishDay: CalendarCheck,
  night: Moon,
  join: Users,
  hidden: Gem,
  stalls: Store,
  family: Baby,
};

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

/** カードとリストの行で共通に使う、候補の材料 */
function useCandidateFacts(candidate: FestivalCandidate, festival: Festival | null) {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const streaming = useApp((state) => state.session.streaming);
  const time = timeRange(candidate.start, candidate.end);
  const category = festival?.category ?? "other";
  return {
    date: formatDate(candidate.date, locale),
    time: time ?? t.candidates.timeUnknown,
    place: `${candidate.place}・${candidate.venueName}`,
    category,
    categoryLabel: festival === null ? null : t.categories[category],
    block: chooseBlock(candidate, streaming),
    ids: {
      heading: `candidate-${candidate.festivalId}`,
      details: `candidate-details-${candidate.festivalId}`,
      note: `candidate-note-${candidate.festivalId}`,
    },
  };
}

/** 出発の駅からの片道の所要時間（条件に照らした値）。分からなければ出さない */
function TravelLine({ candidate }: { candidate: FestivalCandidate }) {
  const t = useT();
  const minutes = candidate.travel?.minutes;
  if (minutes === null || minutes === undefined) return null;
  return (
    <p className="flex items-center gap-1.5 text-ink text-sm" data-testid="candidate-travel">
      <TrainFront aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
      {t.candidates.travel(minutes[0], minutes[1], candidate.travel?.basis === "estimate")}
    </p>
  );
}

/** 条件から外れている点（「この祭りならやっています」の祭り） */
function MissNote({ miss }: { miss: SearchMiss }) {
  const t = useT();
  return (
    <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-shu-500/10 px-2 py-1 font-bold text-shu-700 text-sm">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="sr-only">{t.candidates.next.missLabel}：</span>
        {miss.detail}
      </span>
    </p>
  );
}

/** 希望の日との関係の札（切手のような形） */
function DayStamp({ days }: { days: number }) {
  const t = useT();
  return (
    <span
      className={`inline-flex shrink-0 rotate-2 items-center rounded-sm border-2 border-dashed px-2 py-0.5 font-black text-sm ${
        days === 0
          ? "border-yamabuki-700/50 bg-yamabuki-200 text-ink"
          : "border-ink/30 bg-kinari-50 text-ink"
      }`}
    >
      {t.candidates.daysFromWish(days)}
    </span>
  );
}

/**
 * 開催が確認できていないことの知らせ。「この祭りにする」を押せない理由も兼ねる。
 * 要事前確認の祭りは、選べることと、出発の前に確かめることを知らせる
 */
function UnconfirmedNote({ id, candidate }: { id: string; candidate: FestivalCandidate }) {
  const t = useT();
  return (
    <p
      id={id}
      className="flex items-start gap-1.5 rounded-lg bg-shu-500/10 px-2 py-1 font-medium text-shu-700 text-sm"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {needsCheck(candidate) ? t.candidates.needsCheckNote : t.candidates.unconfirmedNote}
    </p>
  );
}

/** 確認済みでない候補の札：要事前確認か未確認 */
function StatusPill({ candidate }: { candidate: FestivalCandidate }) {
  const t = useT();
  if (candidate.confirmed) return null;
  return (
    <Pill tone="shu">
      {needsCheck(candidate) ? t.candidates.needsCheck : t.candidates.unconfirmed}
    </Pill>
  );
}

function ChooseButton({
  candidate,
  block,
  noteId,
  compact = false,
}: {
  candidate: FestivalCandidate;
  block: ReturnType<typeof chooseBlock>;
  noteId: string;
  compact?: boolean;
}) {
  const t = useT();
  const actions = useActions();
  // 返答の途中に手で開いたときは、押せないボタンを出さず、まだ探していることを書く
  if (block === "busy") {
    return (
      <p
        className={`inline-flex items-center justify-center gap-1.5 rounded-full border-2 border-dashed border-wood-700/30 font-bold text-ink-soft ${
          compact ? "min-h-10 px-3 text-xs" : "min-h-12 w-full px-4 text-sm"
        }`}
      >
        <LoaderCircle
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
        />
        {t.candidates.stillSearching}
      </p>
    );
  }
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border-2 border-wood-700/30 bg-yamabuki-400 font-black text-ink shadow-soft transition hover:brightness-105 disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-200 disabled:text-stone-500 disabled:shadow-none ${
        compact ? "min-h-10 px-3 text-sm" : "min-h-12 w-full px-4 text-lg"
      }`}
      disabled={block !== null}
      aria-describedby={block === "unconfirmed" ? noteId : undefined}
      onClick={() => void actions.chooseCandidate(candidate)}
    >
      <MapPin aria-hidden="true" className={compact ? "size-4" : "size-5"} />
      {t.candidates.choose}
      <ChevronRight aria-hidden="true" className={compact ? "size-4" : "size-5"} />
    </button>
  );
}

function DetailsToggle({
  open,
  controls,
  onToggle,
  compact = false,
}: {
  open: boolean;
  controls: string;
  onToggle: () => void;
  compact?: boolean;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border-2 border-line-strong bg-white/85 font-bold text-ink transition hover:bg-white ${
        compact ? "min-h-10 px-3 text-sm" : "min-h-11 w-full px-4"
      }`}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <BookOpen aria-hidden="true" className="size-4" />
      {open ? t.candidates.hideDetails : t.candidates.details}
      <ChevronDown aria-hidden="true" className={`size-4 transition ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

/** 訂正と掲載停止の窓口 */
function IssueLinks({ candidate }: { candidate: FestivalCandidate }) {
  const t = useT();
  const issueName = `${candidate.name}（${candidate.festivalId}）`;
  return (
    <div className="flex flex-wrap gap-x-3 text-xs">
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
        href={issueUrl("festival-opt-out.yml", t.issues.optOutTitle(candidate.name), issueName)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t.candidates.optOut}
      </a>
    </div>
  );
}

/** 「詳細を見る」で開く中身：おすすめポイント・合う理由・「ここでしか」・祭りの特徴 */
function Details({
  id,
  open,
  candidate,
  festival,
  children,
}: {
  id: string;
  open: boolean;
  candidate: FestivalCandidate;
  festival: Festival | null;
  children?: React.ReactNode;
}) {
  const t = useT();
  const conditions = useApp((state) => state.session.conditions);
  const preferences = useApp((state) => state.preferences);
  const reasons = fitReasons(candidate, festival, conditions, preferences);
  const onlyHere = festival?.trivia[0] ?? null;
  const highlights = festival?.highlights.slice(0, 3) ?? [candidate.highlight];
  return (
    <div
      id={id}
      hidden={!open}
      className="mt-3 grid gap-3 border-line border-t border-dashed pt-3 md:grid-cols-2"
    >
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
      <div className="space-y-3">
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
      {children === undefined ? null : <div className="md:col-span-2">{children}</div>}
    </div>
  );
}

function SourceLine({ candidate }: { candidate: FestivalCandidate }) {
  const t = useT();
  return (
    <div className="text-xs">
      <span className="mr-1 font-bold text-ai-700">{t.candidates.source}</span>
      <SourceLink source={candidate.source} />
    </div>
  );
}

/** カード表示の1枚（横長） */
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
  const [open, setOpen] = useState(false);
  const facts = useCandidateFacts(candidate, festival);
  const tags = faceTags(candidateTags(candidate, festival));

  return (
    <article
      aria-labelledby={facts.ids.heading}
      className={`washi w-full animate-pop rounded-card border-2 p-3 shadow-lift ${
        candidate.confirmed ? "border-shu-500/60" : "border-line-strong"
      }`}
      style={{ animationDelay: `${index * 120}ms` }}
      data-testid="candidate-card"
    >
      <div className="flex flex-col gap-4 md:flex-row">
        <ThemeArt category={facts.category} label={facts.categoryLabel} />

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 id={facts.ids.heading} className="font-black text-2xl text-ink leading-tight">
              {candidate.name}
            </h3>
            <DayStamp days={candidate.daysFromWish} />
          </div>
          <p className="flex items-center gap-1.5 text-ink text-sm sm:text-base">
            <MapPin aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
            {facts.place}
          </p>
          <p className="flex items-center gap-1.5 font-bold text-ink text-lg">
            <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
            {facts.date}
            <span>{facts.time}</span>
          </p>
          <TravelLine candidate={candidate} />
          <p className="font-medium text-ink-soft text-sm">{candidate.highlight}</p>
          {candidate.confirmed ? null : (
            <UnconfirmedNote id={facts.ids.note} candidate={candidate} />
          )}
          {tags.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label={t.festivalCard.features}>
              {tags.map((tag) => {
                const Icon = TAG_ICON[tag];
                return (
                  <li
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-white/85 px-2.5 py-0.5 font-bold text-ink-soft text-xs"
                  >
                    <Icon aria-hidden="true" className="size-3.5 text-shu-600" />
                    {t.candidates.tags[tag]}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 md:w-56 md:shrink-0">
          <span className="flex flex-wrap justify-end gap-1">
            <ConfidenceBadge confidence={candidate.confidence} />
            <StatusPill candidate={candidate} />
          </span>
          <ChooseButton candidate={candidate} block={facts.block} noteId={facts.ids.note} />
          <DetailsToggle open={open} controls={facts.ids.details} onToggle={() => setOpen(!open)} />
        </div>
      </div>

      <Details id={facts.ids.details} open={open} candidate={candidate} festival={festival} />

      <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
        <SourceLine candidate={candidate} />
        <IssueLinks candidate={candidate} />
      </div>
    </article>
  );
}

/** リスト表示の1行：名前・日時・場所・確度と、選ぶボタン */
function Row({
  candidate,
  festival,
  miss,
}: {
  candidate: FestivalCandidate;
  festival: Festival | null;
  /** 「この祭りならやっています」の祭りなら、条件から外れている点 */
  miss?: SearchMiss;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const facts = useCandidateFacts(candidate, festival);
  const cell = "flex min-w-0 items-center gap-1.5";
  return (
    <li>
      <article
        aria-labelledby={facts.ids.heading}
        className="washi rounded-card border border-line-strong px-3 py-2 shadow-soft"
        data-testid="candidate-row"
      >
        <div className="grid items-center gap-x-3 gap-y-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_auto_auto]">
          <div className={cell}>
            <h3 id={facts.ids.heading} className="truncate font-black text-ink text-lg">
              {candidate.name}
            </h3>
            {facts.categoryLabel === null ? null : (
              <span className="shrink-0 rounded-full bg-kinari-200 px-2 py-0.5 font-bold text-ink-soft text-xs">
                {facts.categoryLabel}
              </span>
            )}
          </div>
          <p className={`${cell} font-bold text-ink text-sm`}>
            <span className="sr-only">{t.candidates.columns.date}</span>
            <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
            {facts.date} {facts.time}
          </p>
          <p className={`${cell} text-ink text-sm`}>
            <span className="sr-only">{t.candidates.columns.place}</span>
            <MapPin aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
            <span className="truncate">{facts.place}</span>
          </p>
          <span className="flex flex-wrap items-center gap-1">
            <span className="sr-only">{t.candidates.columns.confidence}</span>
            <ConfidenceBadge confidence={candidate.confidence} />
            <StatusPill candidate={candidate} />
          </span>
          <span className="flex gap-1.5 md:justify-end">
            <ChooseButton
              candidate={candidate}
              block={facts.block}
              noteId={facts.ids.note}
              compact
            />
            <DetailsToggle
              open={open}
              controls={facts.ids.details}
              onToggle={() => setOpen(!open)}
              compact
            />
          </span>
        </div>
        {miss === undefined ? null : <MissNote miss={miss} />}
        <TravelLine candidate={candidate} />
        {candidate.confirmed ? null : (
          <div className="mt-1.5">
            <UnconfirmedNote id={facts.ids.note} candidate={candidate} />
          </div>
        )}
        <Details id={facts.ids.details} open={open} candidate={candidate} festival={festival}>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <SourceLine candidate={candidate} />
            <IssueLinks candidate={candidate} />
          </div>
        </Details>
      </article>
    </li>
  );
}

function FilterSelect<T extends string | number>({
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
  const index = value === null ? -1 : options.findIndex((option) => option.value === value);
  return (
    <label className="inline-flex items-center gap-2 font-bold text-ink text-sm">
      {label}
      <span className="relative">
        <select
          className="min-h-9 cursor-pointer appearance-none rounded-full border border-yamabuki-400 bg-yamabuki-200 py-1 pr-8 pl-3 font-bold text-ink text-sm"
          value={index}
          onChange={(event) => {
            const option = options[Number(event.target.value)];
            onChange(option === undefined ? null : option.value);
          }}
        >
          <option value={-1}>{t.candidates.filters.all}</option>
          {options.map((option, optionIndex) => (
            <option key={String(option.value)} value={optionIndex}>
              {t.candidates.filters.option(text(option.value), option.count)}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2.5 size-4"
        />
      </span>
    </label>
  );
}

/** エリア・時期・テーマの絞り込み（ドロップダウン） */
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
  const filtered = filters.area !== null || filters.month !== null || filters.theme !== null;
  return (
    <section
      aria-label={t.candidates.filters.label}
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      data-testid="candidate-filters"
    >
      <span className="inline-flex items-center gap-1.5 font-black text-ink text-sm">
        <Funnel aria-hidden="true" className="size-4" />
        {t.candidates.filters.label}
      </span>
      <FilterSelect
        label={t.candidates.filters.area}
        options={areas}
        value={filters.area}
        text={(value) => value}
        onChange={(area) => onChange({ ...filters, area })}
      />
      <FilterSelect
        label={t.candidates.filters.month}
        options={months}
        value={filters.month}
        text={(value) => t.candidates.filters.monthName(value)}
        onChange={(month) => onChange({ ...filters, month })}
      />
      <FilterSelect
        label={t.candidates.filters.theme}
        options={themes}
        value={filters.theme}
        text={(value) => (t.categories as Record<string, string>)[value] ?? value}
        onChange={(theme) => onChange({ ...filters, theme })}
      />
      {filtered ? (
        <button
          type="button"
          className="text-ink-soft text-xs underline underline-offset-2"
          onClick={() => onChange(NO_FILTERS)}
        >
          {t.candidates.filters.reset}
        </button>
      ) : null}
    </section>
  );
}

/** カード表示とリスト表示の切り替え */
function ViewSwitch({
  view,
  onChange,
}: {
  view: CandidateView;
  onChange: (view: CandidateView) => void;
}) {
  const t = useT();
  const choices: { value: CandidateView; label: string; Icon: LucideIcon }[] = [
    { value: "cards", label: t.candidates.view.cards, Icon: LayoutGrid },
    { value: "list", label: t.candidates.view.list, Icon: List },
  ];
  return (
    <fieldset
      className="ml-auto inline-flex rounded-full border border-line-strong bg-white/70 p-0.5"
      data-testid="candidate-view"
    >
      <legend className="sr-only">{t.candidates.view.label}</legend>
      {choices.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          className={`inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 font-bold text-sm transition ${
            view === value ? "bg-yamabuki-400 text-ink" : "text-ink-soft hover:bg-white"
          }`}
          onClick={() => onChange(value)}
        >
          <Icon aria-hidden="true" className="size-4" />
          {label}
        </button>
      ))}
    </fieldset>
  );
}

export function CandidateCards() {
  const t = useT();
  const actions = useActions();
  const open = useApp((state) => state.ui.candidatesOpen);
  const candidates = useApp((state) => state.candidates);
  const search = useApp((state) => state.search);
  const festivals = useApp((state) => state.festivals);
  const streaming = useApp((state) => state.session.streaming);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [filters, setFilters] = useState<PostcardFilters>(NO_FILTERS);
  // 表示の切り替えは画面だけの見た目の好みなので、ストアに置かず、この端末に覚えておく
  const [view, setView] = useState<CandidateView>(loadCandidateView);

  useEffect(() => {
    if (open) {
      headingRef.current?.focus();
    }
  }, [open]);
  // 候補が入れ替わったら、絞り込みを戻す
  // biome-ignore lint/correctness/useExhaustiveDependencies: 候補が変わったときだけ戻す
  useEffect(() => setFilters(NO_FILTERS), [candidates]);

  if (!open || (candidates.length === 0 && !hasNextSteps(search))) {
    return null;
  }
  const shown = filterCandidates(candidates, festivals, filters);
  const first = candidates[0];
  // コンシェルジュのひとこと（1行）。くわしいことはカードに書く
  const line = streaming
    ? t.candidates.stillSearching
    : candidates.length === 0
      ? t.candidates.noneFoundLine
      : candidates.length === 1 && first !== undefined
        ? t.candidates.found(candidateArea(first.place))
        : t.candidates.foundMany(candidates.length);
  const changeView = (next: CandidateView) => {
    setView(next);
    saveCandidateView(next);
  };
  return (
    <section
      aria-labelledby="candidates-title"
      className="fixed inset-0 z-40 overflow-y-auto bg-wood-900/55 p-3 backdrop-blur-[3px] sm:p-6"
      data-testid="candidates"
      data-view={view}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          actions.setCandidatesOpen(false);
        }
      }}
    >
      <div className="relative mx-auto mb-3 flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <FestivalBand className="-z-10 pointer-events-none absolute top-0 right-40 hidden h-[4.75rem] w-[26rem] lg:block" />
        <div className="flex min-w-0 items-center gap-3">
          <Portrait speaker="concierge" className="size-14" />
          <div className="min-w-0">
            <h2
              id="candidates-title"
              ref={headingRef}
              tabIndex={-1}
              className="flex items-center gap-2 font-black text-2xl text-kinari-50 drop-shadow"
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
          className="hud-chip inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 font-bold"
          onClick={() => actions.setCandidatesOpen(false)}
        >
          <X aria-hidden="true" className="size-4" />
          {t.candidates.close}
        </button>
      </div>
      {candidates.length === 0 ? null : (
        <div className="washi mx-auto mb-4 flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line-strong px-4 py-2 shadow-soft">
          {candidates.length > 1 ? <Filters filters={filters} onChange={setFilters} /> : null}
          <ViewSwitch view={view} onChange={changeView} />
        </div>
      )}
      {candidates.length === 0 ? (
        <p
          className="washi mx-auto max-w-6xl rounded-card border-2 border-shu-500/50 px-4 py-3 font-black text-ink text-xl"
          role="status"
          data-testid="candidates-none"
        >
          {t.candidates.noneFound}
        </p>
      ) : shown.length === 0 ? (
        <p className="washi mx-auto max-w-6xl rounded-card px-4 py-3 font-bold text-ink">
          {t.candidates.filters.none}
        </p>
      ) : view === "list" ? (
        <ul className="mx-auto flex max-w-6xl flex-col gap-2" aria-label={t.candidates.view.list}>
          {shown.map((candidate) => (
            <Row
              key={candidate.festivalId}
              candidate={candidate}
              festival={festivals[candidate.festivalId] ?? null}
            />
          ))}
        </ul>
      ) : (
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          {shown.map((candidate, index) => (
            <Card
              key={candidate.festivalId}
              candidate={candidate}
              festival={festivals[candidate.festivalId] ?? null}
              index={index}
            />
          ))}
        </div>
      )}
      {search === null ? null : <NextSteps search={search} />}
    </section>
  );
}

/**
 * 条件に合う祭りが足りないときの案内：条件を1つだけ外せば出る祭り（外れている点つき）と、次の手のボタン。
 * 次の手は、サーバーが変えた条件で数え直して見つかったものだけが届く。押すと変えた条件で探し直す
 */
function NextSteps({ search }: { search: SearchOutcome }) {
  const t = useT();
  const actions = useActions();
  const festivals = useApp((state) => state.festivals);
  const streaming = useApp((state) => state.session.streaming);
  if (search.nearMisses.length === 0 && search.suggestions.length === 0) return null;
  return (
    <div className="mx-auto mt-4 flex max-w-6xl flex-col gap-3" data-testid="next-steps">
      {search.nearMisses.length === 0 ? null : (
        <section aria-labelledby="near-misses-title" className="flex flex-col gap-2">
          <div className="washi rounded-card border border-line-strong px-4 py-2 shadow-soft">
            <h3 id="near-misses-title" className="font-black text-ink text-lg">
              {t.candidates.next.nearTitle}
            </h3>
            <p className="text-ink-soft text-sm">{t.candidates.next.nearNote}</p>
          </div>
          <ul className="flex flex-col gap-2">
            {search.nearMisses.map(({ candidate, miss }) => (
              <Row
                key={candidate.festivalId}
                candidate={candidate}
                festival={festivals[candidate.festivalId] ?? null}
                miss={miss}
              />
            ))}
          </ul>
        </section>
      )}
      {search.suggestions.length === 0 ? null : (
        <section
          aria-labelledby="next-steps-title"
          className="washi rounded-card border border-line-strong px-4 py-3 shadow-soft"
        >
          <h3 id="next-steps-title" className="mb-2 font-black text-ink text-lg">
            {t.candidates.next.title}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {search.suggestions.map((suggestion) => (
              <li key={`${suggestion.kind}-${suggestion.label}`}>
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-wood-700/30 bg-kinari-50 px-4 font-bold text-ink shadow-soft transition hover:bg-yamabuki-200 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={streaming}
                  data-testid="next-step"
                  onClick={() => void actions.chooseSuggestion(suggestion)}
                >
                  {suggestion.kind === "edit_conditions" ? (
                    <RotateCcw aria-hidden="true" className="size-4" />
                  ) : null}
                  {t.candidates.next.label(suggestion)}
                  {suggestion.found === null ? null : (
                    <span className="rounded-full bg-yamabuki-400 px-2 py-0.5 text-xs">
                      {t.candidates.next.found(suggestion.found)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
