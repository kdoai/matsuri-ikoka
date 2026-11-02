import type { Festival, FestivalCandidate } from "@matsuri-ikoka/schema";
import { useEffect, useRef } from "react";
import type { Messages } from "../i18n";
import { formatDate } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { type FitReason, fitReasons } from "../state/reasons";
import { buttonPrimary, buttonQuiet, ConfidenceBadge, Pill, SourceLink, timeRange } from "./common";
import { issueUrl } from "./links";

// 祭りの候補カード（最大3枚）。店内に重ねて出し、選ぶと消えて、右のパネルに旅程が出る。

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

  return (
    <article
      aria-labelledby={headingId}
      className="flex animate-pop flex-col rounded-2xl border-2 border-wood-700 bg-kinari-50 p-4 shadow-xl"
      style={{ animationDelay: `${index * 120}ms` }}
      data-testid="candidate-card"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <ConfidenceBadge confidence={candidate.confidence} />
        {candidate.confirmed ? null : <Pill tone="shu">{t.candidates.unconfirmed}</Pill>}
        <Pill tone={candidate.daysFromWish === 0 ? "ai" : "yamabuki"}>
          {t.candidates.daysFromWish(candidate.daysFromWish)}
        </Pill>
      </div>
      <h3 id={headingId} className="mt-2 font-bold text-ink text-xl leading-snug">
        {candidate.name}
      </h3>
      <p className="mt-1 font-semibold text-ink">
        {formatDate(candidate.date, locale)}
        <span className="ml-2">{time ?? t.candidates.timeUnknown}</span>
      </p>
      <p className="text-ink-soft text-sm">
        {candidate.venueName}・{candidate.place}
      </p>
      {candidate.confirmed ? null : (
        <p className="mt-2 rounded-lg bg-shu-500/10 px-2 py-1 font-medium text-shu-700 text-sm">
          {t.candidates.unconfirmedNote}
        </p>
      )}

      <dl className="mt-3 space-y-2 text-sm">
        {reasons.length > 0 ? (
          <div>
            <dt className="font-bold text-ai-700 text-xs">{t.candidates.whyFits}</dt>
            <dd>
              <ul className="list-disc pl-5">
                {reasons.map((reason) => (
                  <li key={reason.kind}>{reasonText(t, reason)}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="font-bold text-ai-700 text-xs">{t.candidates.highlight}</dt>
          <dd className="font-medium">{candidate.highlight}</dd>
        </div>
        {onlyHere === null ? null : (
          <div>
            <dt className="font-bold text-ai-700 text-xs">{t.candidates.onlyHere}</dt>
            <dd>
              {onlyHere.text}
              <div>
                <SourceLink source={onlyHere.source} compact />
              </div>
            </dd>
          </div>
        )}
        <div>
          <dt className="font-bold text-ai-700 text-xs">{t.candidates.source}</dt>
          <dd>
            <SourceLink source={candidate.source} />
          </dd>
        </div>
      </dl>

      <div className="mt-auto pt-3">
        <button
          type="button"
          className={`${buttonPrimary} w-full`}
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
            href={issueUrl("festival-opt-out.yml", t.issues.optOutTitle(candidate.name), issueName)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t.candidates.optOut}
          </a>
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
      className="fixed inset-0 z-40 overflow-y-auto bg-wood-900/55 p-3 backdrop-blur-[2px] sm:p-4 lg:absolute lg:z-20"
      data-testid="candidates"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          actions.setCandidatesOpen(false);
        }
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2
          id="candidates-title"
          ref={headingRef}
          tabIndex={-1}
          className="rounded-lg bg-ai-700 px-3 py-1 font-bold text-lg text-white shadow"
        >
          {t.candidates.title}
        </h2>
        <button
          type="button"
          className={`${buttonQuiet} bg-white`}
          onClick={() => actions.setCandidatesOpen(false)}
        >
          {t.candidates.close}
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
