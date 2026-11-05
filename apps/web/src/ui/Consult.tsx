import {
  CalendarDays,
  ChevronRight,
  Heart,
  Pencil,
  Search,
  Send,
  User,
  Users,
  UsersRound,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  AUTO,
  AUTO_QUESTIONS,
  answerText,
  BUDGET_BASES,
  budgetBasis,
  type ChoiceQuestion,
  CONSULT_OPTIONS,
  CONSULT_QUESTIONS,
  CONSULT_STEPS,
  COUNT_LIMITS,
  type ConsultEntry,
  type ConsultQuestion,
  type ConsultStep,
  canReach,
  DIETARY_OPTIONS,
  effectiveAnswers,
  FAMILY_MEMBERS,
  hasAnyAnswer,
  isAnswered,
  isDayTrip,
  MULTI_QUESTIONS,
  nextStep,
  OTHER,
  OTHER_QUESTIONS,
  type PartyMember,
  partyCounts,
  partySize,
  previousStep,
  STAY_OPTIONS,
  setAmount,
  setBudgetBasis,
  setRange,
  setStay,
  setTravel,
  stepAfterAnswer,
  stepCount,
  TRANSPORT_OPTIONS,
  TRAVEL_LIMITS,
  todayInJapan,
  toggleDietary,
  toggleTransport,
} from "../state/consult";
import { useActions, useApp, useT } from "../state/react";
import {
  Choice,
  ChoiceGroup,
  Counter,
  DecideRow,
  decideButton,
  focusStep,
  OtherField,
  PrefecturePicks,
  StepProgress,
  textField,
} from "./consult/Choices";
import { FestivalSearchPanel, useFestivalSearchLine } from "./consult/FestivalSearch";
import { RangeCalendar } from "./consult/RangeCalendar";
import { StationInput } from "./consult/StationInput";

// 選んで進める相談。最初に入口の2択（祭りから探す / 旅行計画から探す）を出す。
// 旅行計画は、会話の窓の中で、上から順に1つずつ答える一本道の聞き取り。祭りから探す相談は consult/FestivalSearch.tsx。
// 1つだけ選ぶ項目は、選ぶとすぐ次の段階へ進む。いくつでも選べる項目・人数・期間・自由記述は「決定」で進む。
// 上の ＜ ＞ で、答えた段階までを行き来できる。最後の「確認」で、選んだ内容を1つの発言にまとめて送る。

const PARTY_ICON: Record<string, ReactNode> = {
  solo: <User aria-hidden="true" className="size-4" />,
  family: <Users aria-hidden="true" className="size-4" />,
  friends: <UsersRound aria-hidden="true" className="size-4" />,
  partner: <Heart aria-hidden="true" className="size-4" />,
};

/** 聞き取りの操作をまとめたもの（段階の部品で使う） */
function useConsult() {
  const actions = useActions();
  const step = useApp((state) => state.consult.step);
  const editing = useApp((state) => state.consult.editing);
  return {
    actions,
    /** 答えたので次へ（確認から直しに来たときは確認へ） */
    advance() {
      actions.setConsultStep(stepAfterAnswer({ step, editing }));
      focusStep();
    },
  };
}

/** 選択肢で答える項目（だれと・行き先・楽しみ・食べたいもの・ペース・予算） */
function ChoiceStep({ question }: { question: ChoiceQuestion & ConsultQuestion }) {
  const t = useT();
  const { actions, advance } = useConsult();
  const answer = useApp((state) => state.consult.answers[question]);
  const picks = answer?.picks ?? [];
  const multi = MULTI_QUESTIONS.includes(question);
  const options = t.consult.options[question] as Record<string, string>;
  const label = t.consult.labels[question];
  const otherId = `consult-${question}-text`;
  const showOther = picks.includes(OTHER);

  /** 選ぶとすぐ次へ進む選択肢か（人数を入れる家族・友人と、「その他」は除く） */
  const instant = (value: string) =>
    !multi &&
    value !== OTHER &&
    !(question === "party" && (value === "family" || value === "friends"));

  const choose = (value: string) => {
    const pressed = picks.includes(value);
    // 1つだけの項目で、選んである選択肢を押し直したときは外さない
    if (multi || !pressed) actions.pickConsult(question, value);
    if (instant(value)) advance();
    else if (value === OTHER && !pressed) {
      window.requestAnimationFrame(() => document.getElementById(otherId)?.focus());
    }
  };

  const values: string[] = [
    ...CONSULT_OPTIONS[question],
    ...(AUTO_QUESTIONS.includes(question) ? [AUTO] : []),
    ...(OTHER_QUESTIONS.includes(question) ? [OTHER] : []),
  ];
  const labelOf = (value: string) =>
    value === AUTO ? t.consult.auto : value === OTHER ? t.consult.other : (options[value] ?? value);

  const needsDecide =
    multi ||
    showOther ||
    (question === "party" && (picks[0] === "family" || picks[0] === "friends"));

  return (
    <div>
      {question === "budget" ? <BudgetBasisPicks /> : null}
      <ChoiceGroup label={label} hideLabel note={multi ? t.consult.multi : undefined}>
        {values.map((value, index) => (
          <Choice
            key={value}
            pressed={picks.includes(value)}
            onClick={() => choose(value)}
            icon={question === "party" ? PARTY_ICON[value] : undefined}
            focusFirst={index === 0}
          >
            {labelOf(value)}
          </Choice>
        ))}
      </ChoiceGroup>
      {question === "party" ? <PartyCounts /> : null}
      {question === "destination" ? <TravelPicks /> : null}
      {question === "destination" ? <DestinationPrefectures /> : null}
      {question === "food" ? <DietaryPicks /> : null}
      {showOther ? (
        <OtherField
          id={otherId}
          label={t.consult.otherLabel(label)}
          placeholder={t.consult.otherPlaceholder}
          value={answer?.text ?? ""}
          onChange={(text) => actions.setConsultText(question, text)}
          onDecide={advance}
        />
      ) : null}
      {question === "budget" ? <BudgetAmount /> : null}
      {needsDecide ? (
        <DecideRow disabled={!isAnswered(answer, question)} onClick={advance} />
      ) : null}
    </div>
  );
}

/** 家族・友人を選んだときの人数の ＋/− */
function PartyCounts() {
  const t = useT();
  const { actions } = useConsult();
  const answer = useApp((state) => state.consult.answers.party);
  const pick = answer?.picks[0];
  if (pick !== "family" && pick !== "friends") return null;
  const counts = partyCounts(answer);
  const members: readonly PartyMember[] = pick === "family" ? FAMILY_MEMBERS : ["friends"];
  return (
    <div className="mt-2 animate-fade space-y-1" data-testid="consult-counts">
      {members.map((member) => {
        const label = t.consult.members[member];
        // 家族には、大人かシニアを1人は残す
        const keepOne =
          (member === "adults" && counts.seniors === 0) ||
          (member === "seniors" && counts.adults === 0);
        return (
          <Counter
            key={member}
            label={label}
            value={counts[member]}
            min={COUNT_LIMITS[member].min + (keepOne ? 1 : 0)}
            max={COUNT_LIMITS[member].max}
            valueText={t.consult.people(counts[member])}
            decreaseLabel={t.consult.decrease(label)}
            increaseLabel={t.consult.increase(label)}
            onStep={(delta) => actions.editConsult((answers) => stepCount(answers, member, delta))}
          />
        );
      })}
      <p className="text-right font-bold text-ink-soft text-sm">
        {t.consult.total(partySize(answer) ?? 0)}
      </p>
    </div>
  );
}

/** 日帰りのときは、出発の駅からの片道の所要時間でも行き先をしぼれる（泊まりの旅では出さない） */
function TravelPicks() {
  const t = useT();
  const { actions } = useConsult();
  const dayTrip = useApp((state) => isDayTrip(state.consult.answers));
  const travel = useApp((state) => state.consult.answers.destination?.travel);
  if (!dayTrip) return null;
  return (
    <div className="mt-2 animate-fade" data-testid="consult-travel">
      <ChoiceGroup label={t.consult.travelLabel}>
        {TRAVEL_LIMITS.map((minutes) => (
          <Choice
            key={minutes}
            pressed={travel === minutes}
            onClick={() => actions.editConsult((answers) => setTravel(answers, minutes))}
          >
            {t.consult.travelOption(minutes)}
          </Choice>
        ))}
      </ChoiceGroup>
    </div>
  );
}

/** 食べたいものの段階で、あわせて食事で気をつけたいことも伝えられる（選ばなくてもよい） */
function DietaryPicks() {
  const t = useT();
  const { actions } = useConsult();
  const dietary = useApp((state) => state.consult.answers.food?.dietary ?? []);
  return (
    <div className="mt-2" data-testid="consult-dietary">
      <ChoiceGroup label={t.consult.dietaryLabel}>
        {DIETARY_OPTIONS.map((need) => (
          <Choice
            key={need}
            pressed={dietary.includes(need)}
            onClick={() => actions.editConsult((answers) => toggleDietary(answers, need))}
          >
            {t.consult.dietary[need]}
          </Choice>
        ))}
      </ChoiceGroup>
    </div>
  );
}

/** 行き先で地方を選んだら、その中の都道府県でもしぼれる */
function DestinationPrefectures() {
  const { actions } = useConsult();
  const picks = useApp((state) => state.consult.answers.destination?.picks ?? []);
  return (
    <PrefecturePicks picks={picks} onPick={(value) => actions.pickConsult("destination", value)} />
  );
}

/** 予算の数え方（1人あたり / 全員で）。選択肢と金額の前に選ぶ */
function BudgetBasisPicks() {
  const t = useT();
  const { actions } = useConsult();
  const basis = useApp((state) => budgetBasis(state.consult.answers.budget));
  return (
    <div className="mb-2" data-testid="consult-budget-basis">
      <ChoiceGroup label={t.consult.basisLabel}>
        {BUDGET_BASES.map((value) => (
          <Choice
            key={value}
            pressed={basis === value}
            onClick={() => actions.editConsult((answers) => setBudgetBasis(answers, value))}
          >
            {t.consult.wording.budgetBasis[value]}
          </Choice>
        ))}
      </ChoiceGroup>
    </div>
  );
}

/** 予算を金額で伝える欄 */
function BudgetAmount() {
  const t = useT();
  const { actions, advance } = useConsult();
  const amount = useApp((state) => state.consult.answers.budget?.amount);
  const basis = useApp((state) => budgetBasis(state.consult.answers.budget));
  const [draft, setDraft] = useState(amount === undefined ? "" : String(amount));
  const id = "consult-budget-amount";
  const commit = (text: string) => {
    setDraft(text);
    const digits = text.normalize("NFKC").replace(/[^0-9]/g, "");
    actions.editConsult((answers) => setAmount(answers, digits === "" ? null : Number(digits)));
  };
  return (
    <div className="mt-3">
      <label htmlFor={id} className="mb-1 block font-bold text-ink-soft text-sm">
        {t.consult.amountLabel(t.consult.wording.budgetBasis[basis])}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          maxLength={12}
          value={draft}
          onChange={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && amount !== undefined) {
              event.preventDefault();
              advance();
            }
          }}
          className={`${textField} max-w-48 text-right`}
        />
        <span className="font-bold text-ink-soft">{t.consult.amountUnit}</span>
        <button
          type="button"
          className={decideButton}
          disabled={amount === undefined}
          onClick={advance}
        >
          {t.consult.decide}
        </button>
      </div>
    </div>
  );
}

/** 日程：よく使う範囲か、カレンダーで行きと帰りの日を選ぶ */
function ScheduleStep() {
  const t = useT();
  const { actions, advance } = useConsult();
  const answer = useApp((state) => state.consult.answers.schedule);
  const pick = answer?.picks[0];
  const today = todayInJapan();
  // 「日付を指定」を押したときだけ、開いたカレンダーへ焦点を移す（戻ってきたときは移さない）
  const [justOpened, setJustOpened] = useState(false);
  const options = t.consult.options.schedule;

  return (
    <div>
      <ChoiceGroup label={t.consult.labels.schedule} hideLabel>
        {CONSULT_OPTIONS.schedule.map((value, index) => (
          <Choice
            key={value}
            pressed={pick === value}
            focusFirst={index === 0}
            onClick={() => {
              if (pick !== value) actions.pickConsult("schedule", value);
              setJustOpened(value === "dates");
            }}
          >
            {options[value]}
          </Choice>
        ))}
      </ChoiceGroup>
      {pick === "dates" ? (
        <RangeCalendar
          today={today}
          range={answer?.range}
          autoFocus={justOpened}
          onRange={(from, to) => actions.editConsult((answers) => setRange(answers, from, to))}
          onDecide={advance}
        />
      ) : pick !== undefined ? (
        <div className="mt-2 animate-fade">
          <ChoiceGroup label={t.consult.stayLabel}>
            {STAY_OPTIONS.map((stay) => (
              <Choice
                key={stay}
                pressed={answer?.stay === stay}
                onClick={() => {
                  actions.editConsult((answers) => setStay(answers, stay));
                  advance();
                }}
              >
                {t.consult.stay[stay]}
              </Choice>
            ))}
          </ChoiceGroup>
        </div>
      ) : null}
    </div>
  );
}

function OriginStep() {
  const { actions, advance } = useConsult();
  const text = useApp((state) => state.consult.answers.origin?.text ?? "");
  return (
    <div>
      <StationInput
        value={text}
        onChange={(value) => actions.setConsultText("origin", value)}
        onDecide={(value) => {
          actions.setConsultText("origin", value);
          advance();
        }}
      />
      <TransportPicks />
    </div>
  );
}

/** 出発の駅の段階で、あわせて想定している交通手段も伝えられる（選ばなければおまかせ） */
function TransportPicks() {
  const t = useT();
  const { actions } = useConsult();
  const transport = useApp((state) => state.consult.answers.origin?.transport ?? []);
  return (
    <div className="mt-2" data-testid="consult-transport">
      <ChoiceGroup label={t.consult.transportLabel}>
        {TRANSPORT_OPTIONS.map((mode) => (
          <Choice
            key={mode}
            pressed={transport.includes(mode)}
            onClick={() => actions.editConsult((answers) => toggleTransport(answers, mode))}
          >
            {t.consult.transport[mode]}
          </Choice>
        ))}
      </ChoiceGroup>
    </div>
  );
}

/** 最後の「ひとこと」。書かなくても進める */
function NoteStep() {
  const t = useT();
  const { actions, advance } = useConsult();
  const text = useApp((state) => state.consult.answers.note?.text ?? "");
  const id = "consult-note-text";
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {t.consult.labels.note}
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={200}
        value={text}
        placeholder={t.consult.notePlaceholder}
        onChange={(event) => actions.setConsultText("note", event.target.value)}
        className={`${textField} resize-none`}
        data-dialogue-focus=""
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          className={decideButton}
          onClick={advance}
          data-testid="consult-decide"
        >
          {text.trim() === "" ? t.consult.skip : t.consult.decide}
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** 確認：答えの一覧。各行の「直す」で、その段階へ戻る */
function Summary() {
  const t = useT();
  const actions = useActions();
  const answers = effectiveAnswers(useApp((state) => state.consult.answers));
  const today = todayInJapan();
  return (
    <dl className="grid gap-1 sm:grid-cols-2" data-testid="consult-summary">
      {CONSULT_QUESTIONS.map((question, index) => {
        const text = answerText(question, answers[question], t.consult.wording, today);
        return (
          <div
            key={question}
            className="flex items-center gap-2 rounded-card border border-line bg-white/70 py-1 pr-1 pl-3 text-sm"
          >
            <dt className="shrink-0 font-bold text-ink-soft">{t.consult.labels[question]}</dt>
            <dd className={`min-w-0 flex-1 ${text === null ? "text-ink-soft" : "text-ink"}`}>
              {text ?? t.consult.unanswered}
            </dd>
            <button
              type="button"
              className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full px-2 font-bold text-ai-700 text-xs hover:bg-ai-50"
              aria-label={`${t.consult.labels[question]}：${t.consult.edit}`}
              onClick={() => {
                actions.setConsultStep(question, true);
                focusStep();
              }}
              data-dialogue-focus={index === 0 ? "" : undefined}
            >
              <Pencil aria-hidden="true" className="size-3.5" />
              {t.consult.edit}
            </button>
          </div>
        );
      })}
    </dl>
  );
}

/** 上の段：＜ 進み具合 ＞。最初の段階の ＜ は、入口（決めた祭りがあれば、祭りの結果の側）へ戻る */
function Progress() {
  const t = useT();
  const actions = useActions();
  const step = useApp((state) => state.consult.step);
  const answers = useApp((state) => state.consult.answers);
  const index = CONSULT_STEPS.indexOf(step);
  const next = nextStep(step);
  const go = (target: ConsultStep) => {
    actions.setConsultStep(target);
    focusStep();
  };
  return (
    <StepProgress
      label={t.consult.steps[step]}
      index={index}
      done={CONSULT_STEPS.map(
        (id, at) =>
          at < index || (id !== "confirm" && id !== "note" && isAnswered(answers[id], id)),
      )}
      forwardDisabled={step === "confirm" || !canReach(next, answers)}
      onBack={() => {
        if (index === 0) {
          actions.leaveHearing();
          focusStep();
        } else {
          go(previousStep(step));
        }
      }}
      onForward={() => go(next)}
    />
  );
}

function StepBody({ step }: { step: ConsultStep }) {
  switch (step) {
    case "schedule":
      return <ScheduleStep />;
    case "origin":
      return <OriginStep />;
    case "note":
      return <NoteStep />;
    case "confirm":
      return <Summary />;
    default:
      return <ChoiceStep question={step} />;
  }
}

/** 入口の2択。選ばずに下の欄へ書いて送ると、今までの相談として受ける */
function EntryChoices() {
  const t = useT();
  const actions = useActions();
  const choose = (entry: ConsultEntry) => {
    actions.chooseConsultEntry(entry);
    focusStep();
  };
  return (
    <div data-testid="consult-entry">
      <ChoiceGroup label={t.consult.entry.label} hideLabel>
        <Choice
          pressed={false}
          focusFirst
          icon={<Search aria-hidden="true" className="size-4" />}
          onClick={() => choose("festival")}
        >
          {t.consult.entry.festival}
        </Choice>
        <Choice
          pressed={false}
          icon={<CalendarDays aria-hidden="true" className="size-4" />}
          onClick={() => choose("trip")}
        >
          {t.consult.entry.trip}
        </Choice>
      </ChoiceGroup>
      <p className="mt-1 text-ink-soft text-sm">{t.consult.entry.note}</p>
    </div>
  );
}

/** 旅行計画から探す：今までの聞き取り */
function TripHearing() {
  const t = useT();
  const actions = useActions();
  const step = useApp((state) => state.consult.step);
  const answers = useApp((state) => state.consult.answers);
  const ready = useApp((state) => state.session.status === "ready" && !state.session.streaming);
  const canSend = ready && hasAnyAnswer(answers);

  return (
    <>
      <Progress />
      <div className="min-h-24" key={step}>
        <StepBody step={step} />
      </div>
      {step === "confirm" ? (
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            className={decideButton}
            disabled={!canSend}
            onClick={() => void actions.submitConsult()}
            data-testid="consult-submit"
          >
            <Send aria-hidden="true" className="size-4" />
            {t.consult.submit}
          </button>
          {hasAnyAnswer(answers) ? null : (
            <p className="text-ink-soft text-xs">{t.consult.needOne}</p>
          )}
        </div>
      ) : null}
    </>
  );
}

/** 会話の窓の、聞き取りの間の一言 */
export function useConsultLine(): string {
  const t = useT();
  const entry = useApp((state) => state.consult.entry);
  const step = useApp((state) => state.consult.step);
  const festivalLine = useFestivalSearchLine();
  if (entry === null) return t.consult.entry.prompt;
  return entry === "festival" ? festivalLine : t.consult.prompts[step];
}

/** 選んで進める相談の本体（会話の窓の中に出す） */
export function ConsultPanel() {
  const t = useT();
  const entry = useApp((state) => state.consult.entry);
  const ready = useApp((state) => state.session.status === "ready" && !state.session.streaming);

  return (
    <section
      aria-label={t.consult.title}
      className="space-y-3"
      data-testid="consult"
      data-ready={ready}
    >
      {entry === null ? (
        <EntryChoices />
      ) : entry === "festival" ? (
        <FestivalSearchPanel />
      ) : (
        <TripHearing />
      )}
    </section>
  );
}
