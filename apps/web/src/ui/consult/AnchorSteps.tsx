import { type AnchorVisit, MAX_ROUTE_AREAS } from "@matsuri-ikoka/schema";
import { ChevronRight, CircleAlert, Lock, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDate } from "../../i18n";
import {
  anchorDays,
  anchorPlace,
  anchorPreviewKey,
  chooseAnchorDay,
  currentPreview,
  planDatesDiffer,
  selectedNights,
  setAnchorNights,
  setAnchorRange,
  tooManyWishes,
  underMinNights,
  visitsByStatus,
} from "../../state/anchorTrip";
import { CONSULT_OPTIONS, nightsBetween, OTHER, todayInJapan } from "../../state/consult";
import { useApp, useT } from "../../state/react";
import { timeRange } from "../common";
import { errorText } from "../text";
import {
  Choice,
  ChoiceGroup,
  decideButton,
  focusStep,
  OtherField,
  PrefecturePicks,
} from "./Choices";
import { RangeCalendar } from "./RangeCalendar";
import { useConsult } from "./useConsult";

// 祭りを決めたあとの聞き取りの段階（docs/spec/festival-search.md の「祭りを固定した旅程」）。
// 日程は開催回から行く日を選んでから日帰りか泊数を選び、行き先は祭りの開催地を外せない形で出す。
// 確認ではサーバーの組み立てを出す。祭りの文字列とサーバーの文は、文字としてだけ出す。

/** 泊数のボタンで選べる泊数。これより長い旅と、前の日からの旅は、カレンダーで選ぶ */
const NIGHT_CHOICES = [0, 1, 2, 3] as const;

/** 行く日：開催回の中から選ぶ。1つだけなら確かめるだけ */
function AnchorDayPicks() {
  const t = useT();
  const { actions } = useConsult();
  const locale = useApp((state) => state.ui.locale);
  const anchor = useApp((state) => state.consult.anchor);
  const festivalId = anchor?.festivalId ?? "";
  const festival = useApp((state) => state.festivals[festivalId]);
  const fallback = useApp((state) => state.festivalSearch.chosen?.candidate.date ?? null);
  const date = anchor?.date ?? "";
  const days = anchorDays(festival, todayInJapan(), fallback ?? date);
  const words = t.consult.anchored;
  const firstDay = days[0]?.date;
  const known = days.some((day) => day.date === date);

  useEffect(() => {
    if (festivalId !== "") void actions.ensureFestivals([festivalId]);
  }, [actions, festivalId]);

  // 読み込んだ祭りのデータに今の日がなければ、選べる日に合わせる
  useEffect(() => {
    if (!known && firstDay !== undefined) {
      actions.editAnchoredHearing((consult) => chooseAnchorDay(consult, firstDay));
    }
  }, [actions, known, firstDay]);

  const label = (day: (typeof days)[number]) => {
    const time = timeRange(day.start, day.end);
    return `${formatDate(day.date, locale)}${time === null ? "" : ` ${time}`}`;
  };
  const [only] = days;
  if (days.length === 1 && only !== undefined) {
    return (
      <p
        className="rounded-card bg-white/70 px-3 py-2 text-ink text-sm sm:text-base"
        data-testid="anchor-day-fixed"
      >
        <span className="mr-2 font-bold text-ink-soft">{words.dayLabel}</span>
        <span className="font-bold">{label(only)}</span>
        {only.expected ? (
          <span className="ml-2 font-bold text-shu-700 text-sm">{t.candidates.needsCheck}</span>
        ) : null}
      </p>
    );
  }
  return (
    <div data-testid="anchor-days">
      <ChoiceGroup label={words.dayLabel}>
        {days.map((day, index) => (
          <Choice
            key={day.date}
            pressed={day.date === date}
            focusFirst={index === 0}
            onClick={() =>
              actions.editAnchoredHearing((consult) => chooseAnchorDay(consult, day.date))
            }
          >
            {label(day)}
            {day.expected ? (
              <span className="ml-1 text-xs">（{t.candidates.needsCheck}）</span>
            ) : null}
          </Choice>
        ))}
      </ChoiceGroup>
    </div>
  );
}

/** 日程：行く日を選び、日帰りか泊数を選ぶ。カレンダーでは行く日を含む期間だけを選べる */
export function AnchorScheduleStep() {
  const t = useT();
  const { actions, advance } = useConsult();
  const date = useApp((state) => state.consult.anchor?.date ?? "");
  const answers = useApp((state) => state.consult.answers);
  const range = answers.schedule?.range;
  const nights = selectedNights(answers);
  // ボタンの泊数に当たらない期間（前の日から・長い旅）を選んであれば、カレンダーを開いておく
  const [calendar, setCalendar] = useState(
    range !== undefined &&
      (range.from !== date || !(NIGHT_CHOICES as readonly number[]).includes(nights ?? -1)),
  );
  const [justOpened, setJustOpened] = useState(false);
  const words = t.consult.anchored;

  return (
    <div className="space-y-2">
      <AnchorDayPicks />
      <ChoiceGroup label={words.stayLabel}>
        {NIGHT_CHOICES.map((value, index) => (
          <Choice
            key={value}
            pressed={!calendar && nights === value && range?.from === date}
            focusFirst={index === 0}
            onClick={() => {
              setCalendar(false);
              actions.editAnchoredHearing((consult) => setAnchorNights(consult, value));
              advance();
            }}
          >
            {t.consult.wording.nights(value)}
          </Choice>
        ))}
        <Choice
          pressed={calendar}
          onClick={() => {
            setCalendar(true);
            setJustOpened(true);
          }}
        >
          {words.pickDates}
        </Choice>
      </ChoiceGroup>
      {calendar ? (
        <RangeCalendar
          key={date}
          today={todayInJapan()}
          range={range}
          autoFocus={justOpened}
          mustInclude={date}
          onRange={(from, to) =>
            actions.editAnchoredHearing((consult) => setAnchorRange(consult, from, to))
          }
          onDecide={advance}
        />
      ) : null}
    </div>
  );
}

/** 必ず行く祭り。押せる部品にせず、外せないと分かる形で出す */
function MustGo() {
  const t = useT();
  const chosen = useApp((state) => state.festivalSearch.chosen);
  const words = t.consult.anchored;
  if (chosen === null) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-card border-2 border-ai-700/40 bg-ai-50 px-3 py-2 text-ink"
      data-testid="anchor-must-go"
    >
      <Lock aria-hidden="true" className="mt-1 size-4 shrink-0 text-ai-700" />
      <div className="min-w-0">
        <p className="font-bold text-sm sm:text-base">
          <span className="mr-2 rounded-full bg-ai-800 px-2 py-0.5 text-kinari-50 text-xs">
            {words.must}
          </span>
          {chosen.candidate.name}
        </p>
        <p className="text-sm">{anchorPlace(chosen.candidate)}</p>
        <p className="text-ink-soft text-xs">{words.mustNote}</p>
      </div>
    </div>
  );
}

/** 行き先：祭りの開催地は必ず行く。それに加えて、寄りたい場所を選べる（選ばなくてもよい） */
export function AnchorDestinationStep() {
  const t = useT();
  const { actions, advance } = useConsult();
  const answers = useApp((state) => state.consult.answers);
  const answer = answers.destination;
  const picks = answer?.picks ?? [];
  const words = t.consult.anchored;
  const otherId = "consult-destination-text";
  const pick = (value: string) => actions.pickConsult("destination", value);
  const hasWish = picks.some((value) => value !== OTHER || (answer?.text.trim() ?? "") !== "");
  return (
    <div className="space-y-2">
      <MustGo />
      <ChoiceGroup label={words.wishLabel} note={t.consult.multi}>
        {CONSULT_OPTIONS.destination.map((region, index) => (
          <Choice
            key={region}
            pressed={picks.includes(region)}
            focusFirst={index === 0}
            onClick={() => pick(region)}
          >
            {t.consult.options.destination[region]}
          </Choice>
        ))}
        <Choice
          pressed={picks.includes(OTHER)}
          onClick={() => {
            const opening = !picks.includes(OTHER);
            pick(OTHER);
            if (opening) {
              window.requestAnimationFrame(() => document.getElementById(otherId)?.focus());
            }
          }}
        >
          {t.consult.other}
        </Choice>
      </ChoiceGroup>
      <PrefecturePicks picks={picks} onPick={pick} />
      {picks.includes(OTHER) ? (
        <OtherField
          id={otherId}
          label={t.consult.otherLabel(words.wishLabel)}
          placeholder={t.consult.otherPlaceholder}
          value={answer?.text ?? ""}
          onChange={(text) => actions.setConsultText("destination", text)}
          onDecide={advance}
        />
      ) : null}
      {tooManyWishes(answers) ? (
        <p className="font-bold text-shu-700 text-sm" data-testid="anchor-wish-limit">
          {words.wishLimit(MAX_ROUTE_AREAS)}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          className={decideButton}
          onClick={advance}
          data-testid="consult-decide"
        >
          {hasWish ? t.consult.decide : t.consult.skip}
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}

const VISIT_STYLE: Record<AnchorVisit["status"], string> = {
  included: "text-ai-700",
  maybe: "text-wood-700",
  dropped: "text-shu-700",
};

function VisitGroup({ status, visits }: { status: AnchorVisit["status"]; visits: AnchorVisit[] }) {
  const t = useT();
  if (visits.length === 0) return null;
  return (
    <div data-testid={`anchor-visits-${status}`}>
      <h4 className={`font-bold text-xs ${VISIT_STYLE[status]}`}>
        {t.consult.anchored.plan[status]}
      </h4>
      <ul className="space-y-0.5 text-ink text-sm">
        {visits.map((visit) => (
          <li key={visit.name}>
            <span className="font-bold">{visit.name}</span>
            {visit.reason === null ? null : (
              <span className="ml-1 text-ink-soft">{visit.reason}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 確認：サーバーが計算した旅の組み立て。確かめられなくても、そのまま送れる */
export function AnchorConfirm() {
  const t = useT();
  const { actions } = useConsult();
  const locale = useApp((state) => state.ui.locale);
  const consult = useApp((state) => state.consult);
  const sessionId = useApp((state) => state.session.id);
  const key = anchorPreviewKey(consult, sessionId);
  const preview = currentPreview(consult, sessionId);
  const words = t.consult.anchored.plan;

  // 答えが変わったら確かめ直す（同じ答えなら、ストアが読み直さない）
  useEffect(() => {
    if (key !== null) void actions.loadAnchorPreview();
  }, [actions, key]);

  const { plan } = preview;
  return (
    <section
      aria-label={words.title}
      className="space-y-2 rounded-card border border-line bg-white/70 p-3"
      data-testid="anchor-plan"
      data-status={preview.status}
    >
      <MustGo />
      {preview.status === "failed" && preview.error !== null ? (
        <div role="alert" data-testid="anchor-plan-error">
          <p className="flex items-start gap-1.5 font-bold text-shu-700 text-sm">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {errorText(preview.error, locale, t)}
          </p>
          <p className="mt-1 text-ink-soft text-sm">{words.failed}</p>
          <button
            type="button"
            className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-full px-3 font-bold text-ai-700 text-sm hover:bg-ai-50"
            onClick={() => void actions.loadAnchorPreview()}
            data-testid="anchor-plan-retry"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            {words.retry}
          </button>
        </div>
      ) : null}
      {plan === null ? (
        preview.status === "failed" ? null : (
          <p role="status" className="text-ink-soft text-sm" data-testid="anchor-plan-loading">
            {words.loading}
          </p>
        )
      ) : (
        <>
          <dl className="space-y-1 text-sm">
            <div>
              <dt className="font-bold text-ink-soft text-xs">{words.dates}</dt>
              <dd className="font-bold text-ink" data-testid="anchor-plan-dates">
                {t.consult.wording.range(
                  formatDate(plan.startDate, locale),
                  formatDate(plan.endDate, locale),
                )}
                <span className="ml-2 font-normal">
                  {t.consult.wording.nights(nightsBetween(plan.startDate, plan.endDate))}
                </span>
              </dd>
              {planDatesDiffer(consult.answers, plan) ? (
                <dd className="text-ink-soft text-xs">{words.datesNote}</dd>
              ) : null}
            </div>
            <div>
              <dt className="font-bold text-ink-soft text-xs">{words.order}</dt>
              <dd>
                <ol
                  className="flex flex-wrap items-center gap-1 text-ink"
                  data-testid="anchor-plan-order"
                >
                  {plan.order.map((place, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同じ場所を行きと帰りに通ることがある
                    <li key={`${place}-${index}`} className="flex items-center gap-1">
                      {index === 0 ? null : (
                        <ChevronRight aria-hidden="true" className="size-3.5 text-ink-soft" />
                      )}
                      {place}
                    </li>
                  ))}
                </ol>
              </dd>
            </div>
          </dl>
          <VisitGroup status="included" visits={visitsByStatus(plan).included} />
          <VisitGroup status="maybe" visits={visitsByStatus(plan).maybe} />
          <VisitGroup status="dropped" visits={visitsByStatus(plan).dropped} />
          {plan.warnings.length === 0 ? null : (
            <div className="rounded-lg bg-shu-500/10 px-2 py-1" data-testid="anchor-plan-warnings">
              <h4 className="font-bold text-shu-700 text-xs">{words.warnings}</h4>
              <ul className="text-ink text-sm">
                {plan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          {plan.minNights !== null && underMinNights(plan) ? (
            <button
              type="button"
              className={decideButton}
              onClick={() => {
                actions.setConsultStep("schedule", true);
                focusStep();
              }}
              data-testid="anchor-fix-nights"
            >
              {words.fixNights(plan.minNights)}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
