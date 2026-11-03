import type { Festival, FestivalCandidate } from "@matsuri-ikoka/schema";
import { Check, MapPin, Star, Users, UtensilsCrossed } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Messages } from "../i18n";
import { formatDate } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { type FitReason, fitReasons } from "../state/reasons";
import { ConfidenceBadge, Pill, SourceLink, timeRange } from "./common";
import { CATEGORY_ICON, CATEGORY_TONE, LanternIcon } from "./icons";
import { issueUrl } from "./links";

// 祭りの候補（最大3枚）。祭りのカードとして並べ、種類の紋章、おすすめポイント、
// 「ここでしか」、祭りの特徴（規模・穴場度・加われるか・屋台・地元の味）を一目で見せる。
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
  const reasons = fitReasons(candidate, festival, conditions, preferences);
  const onlyHere = festival?.trivia[0] ?? null;
  const time = timeRange(candidate.start, candidate.end);
  const headingId = `candidate-${candidate.festivalId}`;
  const issueName = `${candidate.name}（${candidate.festivalId}）`;
  const category = festival?.category ?? "other";
  const Emblem = festival === null ? LanternIcon : (CATEGORY_ICON[category] ?? LanternIcon);
  const tone = CATEGORY_TONE[category] ?? CATEGORY_TONE.other;
  const highlights = festival?.highlights.slice(0, 3) ?? [candidate.highlight];

  return (
    <article
      aria-labelledby={headingId}
      className="flex w-full animate-pop flex-col overflow-hidden rounded-[1.6rem] md:w-[23rem] border-[3px] border-wood-700 bg-gradient-to-b from-[#fffaf0] to-[#f4e6c8] shadow-[0_14px_36px_rgb(0_0_0/0.45)]"
      style={{ animationDelay: `${index * 120}ms` }}
      data-testid="candidate-card"
    >
      {/* 紋章の帯 */}
      <div className={`relative bg-gradient-to-br ${tone} px-4 pt-3 pb-4 text-kinari-50`}>
        <div className="flex items-center gap-3 pr-24">
          <span className="grid size-14 shrink-0 place-items-center rounded-full border-[3px] border-kinari-50/90 bg-black/15 shadow-inner">
            <Emblem className="size-8" />
          </span>
          <div className="min-w-0">
            {festival === null ? null : (
              <p className="font-bold text-kinari-100 text-xs">{t.categories[category]}</p>
            )}
            <h3 id={headingId} className="font-bold text-xl leading-tight">
              {candidate.name}
            </h3>
          </div>
        </div>
        <span
          className={`-rotate-3 absolute top-3 right-3 rounded-md px-2 py-0.5 font-black text-xs shadow ${
            candidate.daysFromWish === 0 ? "bg-yamabuki-400 text-ink" : "bg-kinari-50 text-ink"
          }`}
        >
          {t.candidates.daysFromWish(candidate.daysFromWish)}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 px-4 pt-3 pb-4">
        <div>
          <p className="font-bold text-ink text-lg">
            {formatDate(candidate.date, locale)}
            <span className="ml-2">{time ?? t.candidates.timeUnknown}</span>
          </p>
          <p className="flex items-center gap-1 text-ink-soft text-sm">
            <MapPin aria-hidden="true" className="size-3.5" />
            {candidate.venueName}・{candidate.place}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <ConfidenceBadge confidence={candidate.confidence} />
            {candidate.confirmed ? null : <Pill tone="shu">{t.candidates.unconfirmed}</Pill>}
          </div>
          {candidate.confirmed ? null : (
            <p className="mt-1.5 rounded-lg bg-shu-500/10 px-2 py-1 font-medium text-shu-700 text-sm">
              {t.candidates.unconfirmedNote}
            </p>
          )}
        </div>

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
            className="rounded-xl border-2 border-wood-400/70 border-dashed bg-white/60 px-3 py-2"
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

        <div className="text-xs">
          <span className="mr-1 font-bold text-ai-700">{t.candidates.source}</span>
          <SourceLink source={candidate.source} />
        </div>

        <div className="mt-auto">
          <button
            type="button"
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border-2 border-wood-700/40 bg-yamabuki-400 px-4 font-black text-ink text-lg shadow-[inset_0_-4px_0_rgb(0_0_0/0.15)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:bg-stone-300"
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

export function CandidateCards() {
  const t = useT();
  const actions = useActions();
  const open = useApp((state) => state.ui.candidatesOpen);
  const candidates = useApp((state) => state.candidates);
  const festivals = useApp((state) => state.festivals);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (open) {
      headingRef.current?.focus();
    }
  }, [open]);

  if (!open || candidates.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="candidates-title"
      className="fixed inset-0 z-40 overflow-y-auto bg-ai-900/60 p-3 backdrop-blur-[3px] sm:p-6"
      data-testid="candidates"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          actions.setCandidatesOpen(false);
        }
      }}
    >
      <div className="mx-auto mb-4 flex max-w-6xl items-center justify-between gap-2">
        <h2
          id="candidates-title"
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 rounded-full bg-yamabuki-400 px-5 py-1.5 font-black text-ink text-xl shadow-lg"
        >
          <LanternIcon className="size-6" />
          {t.candidates.title}
        </h2>
        <button
          type="button"
          className="min-h-10 rounded-full border-2 border-kinari-50/80 bg-ink/60 px-4 font-bold text-kinari-50 shadow hover:bg-ink/80"
          onClick={() => actions.setCandidatesOpen(false)}
        >
          {t.candidates.close}
        </button>
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap items-stretch justify-center gap-4">
        {candidates.map((candidate, index) => (
          <Card
            key={candidate.festivalId}
            candidate={candidate}
            festival={festivals[candidate.festivalId] ?? null}
            index={index}
          />
        ))}
      </div>
    </section>
  );
}
