import {
  FESTIVAL_KINDS,
  type Festival,
  type FestivalCandidate,
  MAX_FESTIVAL_WISH_LENGTH,
  SEASONS,
  UNKNOWN,
} from "@matsuri-ikoka/schema";
import {
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Flag,
  MapPin,
  RotateCcw,
  Search,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useEffect } from "react";
import { formatDate, type Messages } from "../../i18n";
import { AUTO, CONSULT_OPTIONS } from "../../state/consult";
import {
  canReachFestivalStep,
  FESTIVAL_SEARCH_STEPS,
  type FestivalSearchStep,
  isFestivalStepDone,
  nextFestivalStep,
  previousFestivalStep,
  setSeason,
  setWish,
  toggleArea,
  toggleKind,
} from "../../state/festivalSearch";
import { useActions, useApp, useT } from "../../state/react";
import { SourceLink, timeRange } from "../common";
import { errorText } from "../text";
import {
  Choice,
  ChoiceGroup,
  DecideRow,
  decideButton,
  focusStep,
  PrefecturePicks,
  StepProgress,
  textField,
} from "./Choices";

// 祭りから探す相談（会話の窓の中）。種類 → 季節 → 地域 → その他の希望 の順に聞き、＜ ＞ で行き来できる。
// 祭りを選んだあとは、「旅行計画を作成する」「ここで終わる」「ほかの祭りを見る」を出す。
// 店員の文はすべて決まった文で、モデルに書かせない。祭りの文字列は文字としてだけ出す。

function KindsStep() {
  const t = useT();
  const actions = useActions();
  const kinds = useApp((state) => state.festivalSearch.answers.kinds);
  const values: string[] = [...FESTIVAL_KINDS, AUTO];
  const labelOf = (value: string) =>
    value === AUTO
      ? t.consult.auto
      : t.festivalSearch.kinds[value as keyof typeof t.festivalSearch.kinds];
  return (
    <div>
      <ChoiceGroup label={t.festivalSearch.labels.kinds} hideLabel note={t.consult.multi}>
        {values.map((value, index) => (
          <Choice
            key={value}
            pressed={kinds.includes(value)}
            focusFirst={index === 0}
            onClick={() => actions.editFestivalAnswers((answers) => toggleKind(answers, value))}
          >
            {labelOf(value)}
          </Choice>
        ))}
      </ChoiceGroup>
      <DecideRow
        disabled={kinds.length === 0}
        onClick={() => {
          actions.setFestivalStep("season");
          focusStep();
        }}
      />
    </div>
  );
}

function SeasonStep() {
  const t = useT();
  const actions = useActions();
  const season = useApp((state) => state.festivalSearch.answers.season);
  const values = [...SEASONS, AUTO] as const;
  return (
    <ChoiceGroup label={t.festivalSearch.labels.season} hideLabel>
      {values.map((value, index) => (
        <Choice
          key={value}
          pressed={season === value}
          focusFirst={index === 0}
          onClick={() => {
            actions.editFestivalAnswers((answers) => setSeason(answers, value));
            actions.setFestivalStep("area");
            focusStep();
          }}
        >
          {value === AUTO ? t.consult.auto : t.festivalSearch.seasons[value]}
        </Choice>
      ))}
    </ChoiceGroup>
  );
}

function AreaStep() {
  const t = useT();
  const actions = useActions();
  const area = useApp((state) => state.festivalSearch.answers.area);
  const pick = (value: string) =>
    actions.editFestivalAnswers((answers) => toggleArea(answers, value));
  return (
    <div>
      <ChoiceGroup label={t.festivalSearch.labels.area} hideLabel note={t.consult.multi}>
        {CONSULT_OPTIONS.destination.map((region, index) => (
          <Choice
            key={region}
            pressed={area.includes(region)}
            focusFirst={index === 0}
            onClick={() => pick(region)}
          >
            {t.consult.options.destination[region]}
          </Choice>
        ))}
        <Choice pressed={area.includes(AUTO)} onClick={() => pick(AUTO)}>
          {t.festivalSearch.areaAuto}
        </Choice>
      </ChoiceGroup>
      <PrefecturePicks picks={area} onPick={pick} />
      <DecideRow
        disabled={area.length === 0}
        onClick={() => {
          actions.setFestivalStep("wish");
          focusStep();
        }}
      />
    </div>
  );
}

function WishStep() {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const actions = useActions();
  const wish = useApp((state) => state.festivalSearch.answers.wish);
  const error = useApp((state) => state.festivalSearch.error);
  const ready = useApp((state) => state.session.status === "ready" && !state.session.streaming);
  const id = "festival-wish-text";
  // 探すのに失敗して戻ってきたら、この段階に焦点を戻す（押したボタンは探している間に消える）
  useEffect(() => {
    if (error !== null) focusStep();
  }, [error]);
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {t.festivalSearch.wishLabel}
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={MAX_FESTIVAL_WISH_LENGTH}
        value={wish}
        placeholder={t.festivalSearch.wishPlaceholder}
        onChange={(event) => {
          const text = event.target.value;
          actions.editFestivalAnswers((answers) => setWish(answers, text));
        }}
        className={`${textField} resize-none`}
        data-dialogue-focus=""
      />
      {error === null ? null : (
        <p
          role="alert"
          className="mt-1 flex items-start gap-1.5 font-bold text-shu-700 text-sm"
          data-testid="festival-search-error"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {errorText(error, locale, t)}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          className={decideButton}
          disabled={!ready}
          onClick={() => void actions.searchFestivals()}
          data-testid="festival-search-submit"
        >
          <Search aria-hidden="true" className="size-4" />
          {error === null ? t.festivalSearch.search : t.festivalSearch.retry}
        </button>
      </div>
    </div>
  );
}

function StepBody({ step }: { step: FestivalSearchStep }) {
  switch (step) {
    case "kinds":
      return <KindsStep />;
    case "season":
      return <SeasonStep />;
    case "area":
      return <AreaStep />;
    case "wish":
      return <WishStep />;
  }
}

/** 聞き取りの段階。最初の段階の ＜ は入口へ戻る */
function Asking() {
  const t = useT();
  const actions = useActions();
  const step = useApp((state) => state.festivalSearch.step);
  const answers = useApp((state) => state.festivalSearch.answers);
  const index = FESTIVAL_SEARCH_STEPS.indexOf(step);
  const next = nextFestivalStep(step);
  const go = (target: FestivalSearchStep) => {
    actions.setFestivalStep(target);
    focusStep();
  };
  return (
    <>
      <StepProgress
        label={t.festivalSearch.steps[step]}
        index={index}
        done={FESTIVAL_SEARCH_STEPS.map((id) => id !== "wish" && isFestivalStepDone(answers, id))}
        forwardDisabled={next === null || !canReachFestivalStep(next, answers)}
        onBack={() => {
          const previous = previousFestivalStep(step);
          if (previous === null) {
            actions.leaveHearing();
            focusStep();
          } else {
            go(previous);
          }
        }}
        onForward={() => {
          if (next !== null) go(next);
        }}
      />
      <div className="min-h-24" key={step}>
        <StepBody step={step} />
      </div>
    </>
  );
}

/** 探した祭りの一覧を閉じたときの選択肢 */
function ResultsClosed() {
  const t = useT();
  const actions = useActions();
  return (
    <ChoiceGroup label={t.festivalSearch.results.title} hideLabel>
      <Choice
        pressed={false}
        focusFirst
        icon={<Sparkles aria-hidden="true" className="size-4" />}
        onClick={() => actions.setFestivalResultsOpen(true)}
      >
        {t.festivalSearch.results.reopen}
      </Choice>
      <Choice
        pressed={false}
        icon={<RotateCcw aria-hidden="true" className="size-4" />}
        onClick={() => {
          actions.editFestivalConditions();
          focusStep();
        }}
      >
        {t.consult.reopen}
      </Choice>
      <Choice
        pressed={false}
        icon={<Undo2 aria-hidden="true" className="size-4" />}
        onClick={() => {
          actions.startConsultOver();
          focusStep();
        }}
      >
        {t.consult.startOver}
      </Choice>
    </ChoiceGroup>
  );
}

function ChosenFacts({ candidate }: { candidate: FestivalCandidate }) {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const words = t.festivalSearch.finished;
  return (
    <dl className="space-y-1 text-ink text-sm sm:text-base">
      <div className="flex items-start gap-1.5">
        <CalendarDays aria-hidden="true" className="mt-1 size-4 shrink-0 text-ink-soft" />
        <dt className="sr-only">{words.when}</dt>
        <dd className="font-bold">
          {formatDate(candidate.date, locale)}{" "}
          {timeRange(candidate.start, candidate.end) ?? t.candidates.timeUnknown}
          {candidate.confirmed ? null : (
            <span className="ml-2 font-bold text-shu-700 text-sm">{t.candidates.needsCheck}</span>
          )}
        </dd>
      </div>
      <div className="flex items-start gap-1.5">
        <MapPin aria-hidden="true" className="mt-1 size-4 shrink-0 text-ink-soft" />
        <dt className="sr-only">{words.where}</dt>
        <dd>
          {candidate.place}・{candidate.venueName}
        </dd>
      </div>
    </dl>
  );
}

/** 祭りを選んだあと：旅行計画を作成する / ここで終わる / ほかの祭りを見る */
function Decide() {
  const t = useT();
  const actions = useActions();
  const chosen = useApp((state) => state.festivalSearch.chosen);
  const words = t.festivalSearch.decide;
  if (chosen === null) return null;
  return (
    <div className="space-y-2" data-testid="festival-decide">
      <ChosenFacts candidate={chosen.candidate} />
      <ChoiceGroup label={words.label} hideLabel>
        <Choice
          pressed={false}
          focusFirst
          icon={<CalendarDays aria-hidden="true" className="size-4" />}
          onClick={() => {
            actions.planFestivalTrip();
            focusStep();
          }}
        >
          {words.plan}
        </Choice>
        <Choice
          pressed={false}
          icon={<Flag aria-hidden="true" className="size-4" />}
          onClick={() => {
            actions.finishFestivalSearch();
            focusStep();
          }}
        >
          {words.finish}
        </Choice>
        <Choice
          pressed={false}
          icon={<Search aria-hidden="true" className="size-4" />}
          onClick={() => actions.backToFestivalResults()}
        >
          {words.others}
        </Choice>
      </ChoiceGroup>
    </div>
  );
}

/** 作法の項目を、短い文の並びにする。分からない項目は「不明」と出す（推測で埋めない） */
function etiquettePoints(festival: Festival, t: Messages): { label: string; text: string }[] {
  const { etiquette } = festival;
  const words = t.etiquette;
  const list = (value: readonly string[] | typeof UNKNOWN) =>
    value === UNKNOWN ? words.unknown : value.join("・");
  return [
    {
      label: words.labels.participation,
      text:
        etiquette.participation === UNKNOWN
          ? words.unknown
          : words.participation[etiquette.participation],
    },
    { label: words.labels.rules, text: list(etiquette.rules) },
    { label: words.labels.dress, text: list(etiquette.dress) },
    { label: words.labels.bring, text: list(etiquette.bring) },
    {
      label: words.labels.risk,
      text:
        etiquette.risk === UNKNOWN
          ? words.unknown
          : `${words.risk[etiquette.risk.level]}（${etiquette.risk.reason}）`,
    },
    {
      label: words.labels.photo,
      text:
        etiquette.photo === UNKNOWN
          ? words.unknown
          : [words.photo[etiquette.photo.policy], etiquette.photo.note]
              .filter((part) => part !== undefined)
              .join("："),
    },
  ];
}

/** 「ここで終わる」：祭りの日時・場所・作法の要点・出典を出して終える */
function Finished() {
  const t = useT();
  const actions = useActions();
  const chosen = useApp((state) => state.festivalSearch.chosen);
  const festivalId = chosen?.candidate.festivalId ?? "";
  const festival = useApp((state) => state.festivals[festivalId] ?? null);
  const load = useApp((state) => state.festivalLoad[festivalId]);
  const words = t.festivalSearch.finished;
  if (chosen === null) return null;
  return (
    <div className="space-y-2" data-testid="festival-finished">
      <ChosenFacts candidate={chosen.candidate} />
      <section aria-label={words.etiquette}>
        <h4 className="mb-1 font-bold text-ai-700 text-xs">{words.etiquette}</h4>
        {festival === null ? (
          <p className="text-ink-soft text-sm">
            {load === "loading" ? t.festivalCard.loading : words.etiquetteNone}
          </p>
        ) : (
          <>
            <dl className="grid gap-1 text-sm sm:grid-cols-2">
              {etiquettePoints(festival, t).map((point) => (
                <div key={point.label} className="rounded-lg bg-white/70 px-2 py-1">
                  <dt className="font-bold text-ink-soft text-xs">{point.label}</dt>
                  <dd className="text-ink">{point.text}</dd>
                </div>
              ))}
            </dl>
            {festival.etiquette.sources[0] === undefined ? null : (
              <div className="mt-1 text-xs">
                <SourceLink source={festival.etiquette.sources[0]} compact />
              </div>
            )}
          </>
        )}
      </section>
      <div className="text-xs">
        <span className="mr-1 font-bold text-ai-700">{words.source}</span>
        <SourceLink source={chosen.candidate.source} />
      </div>
      <p className="flex items-start gap-1.5 rounded-lg bg-shu-500/10 px-2 py-1 font-bold text-shu-700 text-sm">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {words.confirm}
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          className={decideButton}
          data-dialogue-focus=""
          data-testid="festival-restart"
          onClick={() => {
            actions.startConsultOver();
            focusStep();
          }}
        >
          {words.restart}
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** 祭りから探す相談の本体 */
export function FestivalSearchPanel() {
  const actions = useActions();
  const phase = useApp((state) => state.festivalSearch.phase);
  const chosenId = useApp((state) => state.festivalSearch.chosen?.candidate.festivalId ?? null);

  // 選んだ祭りの作法を、ここで終えるときに読めるよう読み込んでおく
  useEffect(() => {
    if (chosenId !== null) void actions.ensureFestivals([chosenId]);
  }, [actions, chosenId]);

  switch (phase) {
    case "asking":
      return <Asking />;
    case "searching":
      return null;
    case "results":
      return <ResultsClosed />;
    case "decide":
      return <Decide />;
    case "finished":
      return <Finished />;
  }
}

/** 会話の窓の、祭りから探す相談の間の一言 */
export function useFestivalSearchLine(): string {
  const t = useT();
  const words = t.festivalSearch;
  const phase = useApp((state) => state.festivalSearch.phase);
  const step = useApp((state) => state.festivalSearch.step);
  const name = useApp((state) => state.festivalSearch.chosen?.candidate.name ?? "");
  const count = useApp((state) => state.festivalSearch.results.length);
  const remaining = useApp((state) => state.festivalSearch.remaining);
  switch (phase) {
    case "asking":
      return words.prompts[step];
    case "searching":
      return words.searching;
    case "results":
      if (count === 0) return words.results.noneLine;
      return remaining === 0 ? words.results.allShownLine : words.results.found(count);
    case "decide":
      return words.decide.prompt(name);
    case "finished":
      return words.finished.prompt(name);
  }
}
