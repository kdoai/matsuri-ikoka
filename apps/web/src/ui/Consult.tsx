import {
  Check,
  ChevronLeft,
  ChevronRight,
  Heart,
  Send,
  User,
  Users,
  UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  AUTO,
  answerText,
  CONSULT_OPTIONS,
  CONSULT_STEPS,
  type ConsultQuestion,
  type ConsultStep,
  hasAnyAnswer,
  isAnswered,
  MULTI_QUESTIONS,
  nextStep,
  OTHER,
  previousStep,
  STEP_QUESTIONS,
  todayInJapan,
} from "../state/consult";
import { useActions, useApp, useT } from "../state/react";

// 選んで進める相談。会話の窓の中で、段階のタブ（誰と › いつ › どこへ › …）と大きな選択肢のボタンを出す。
// どの項目にも「おまかせ」と「その他」があり、「その他」を選ぶと自由記述の欄が開く。
// 最後の「確認」で、選んだ内容を1つの発言にまとめて送る。

const PARTY_ICON: Record<string, ReactNode> = {
  solo: <User aria-hidden="true" className="size-6" />,
  family: <Users aria-hidden="true" className="size-6" />,
  friends: <UsersRound aria-hidden="true" className="size-6" />,
  partner: <Heart aria-hidden="true" className="size-6" />,
};

/** 選択肢のボタンの見た目。選んだものは山吹色で、右上にしるしを付ける */
export const choiceButton =
  "relative flex min-h-12 min-w-[6.5rem] flex-col items-center justify-center gap-1 rounded-card border-2 bg-white/90 px-3 py-2 font-bold text-ink text-sm shadow-soft transition hover:-translate-y-0.5 hover:border-yamabuki-400 disabled:cursor-not-allowed disabled:opacity-60 sm:text-base";

function ChoiceButton({
  pressed,
  onClick,
  icon,
  children,
  testId,
}: {
  pressed: boolean;
  onClick: () => void;
  icon?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
      data-dialogue-focus=""
      className={`${choiceButton} ${
        pressed ? "border-yamabuki-400 bg-yamabuki-100" : "border-line-strong"
      }`}
    >
      {pressed ? (
        <span className="-top-2 -right-2 absolute grid size-5 place-items-center rounded-full bg-yamabuki-400 text-ink shadow-soft">
          <Check aria-hidden="true" className="size-3.5" />
        </span>
      ) : null}
      {icon}
      {children}
    </button>
  );
}

const textField =
  "min-h-11 w-full rounded-card border-2 border-line-strong bg-white px-3 py-2 text-base text-ink shadow-inner placeholder:text-stone-500 focus:border-ai-500 focus:outline-none";

/** 1つの項目の選択肢 */
function Question({ question, showLabel }: { question: ConsultQuestion; showLabel: boolean }) {
  const t = useT();
  const actions = useActions();
  const answer = useApp((state) => state.consult.answers[question]);
  const picks = answer?.picks ?? [];
  const text = answer?.text ?? "";
  const label = t.consult.labels[question];
  const options = t.consult.options[question] as Record<string, string>;
  const multi = MULTI_QUESTIONS.includes(question);
  const inputId = `consult-${question}-text`;

  if (question === "origin") {
    return (
      <div>
        <label htmlFor={inputId} className="mb-1 block font-bold text-ink-soft text-sm">
          {label}
        </label>
        <input
          id={inputId}
          type="text"
          maxLength={50}
          value={text}
          placeholder={t.consult.originPlaceholder}
          onChange={(event) => actions.setConsultText(question, event.target.value)}
          className={textField}
          data-dialogue-focus=""
        />
      </div>
    );
  }

  const showText = picks.includes(OTHER) || (question === "when" && picks.includes("date"));
  return (
    <fieldset>
      <legend className={showLabel ? "mb-1 font-bold text-ink-soft text-sm" : "sr-only"}>
        {label}
        {multi ? <span className="ml-2 font-normal text-xs">（{t.consult.multi}）</span> : null}
      </legend>
      <div className="flex flex-wrap gap-2">
        {CONSULT_OPTIONS[question].map((value) => (
          <ChoiceButton
            key={value}
            pressed={picks.includes(value)}
            onClick={() => actions.pickConsult(question, value)}
            icon={question === "party" ? PARTY_ICON[value] : undefined}
            testId="consult-choice"
          >
            {options[value] ?? value}
          </ChoiceButton>
        ))}
        <ChoiceButton
          pressed={picks.includes(AUTO)}
          onClick={() => actions.pickConsult(question, AUTO)}
          testId="consult-choice"
        >
          {t.consult.auto}
        </ChoiceButton>
        <ChoiceButton
          pressed={picks.includes(OTHER)}
          onClick={() => {
            actions.pickConsult(question, OTHER);
            // 自由記述の欄が開いたら、そこへ移る
            if (!picks.includes(OTHER)) {
              window.requestAnimationFrame(() => document.getElementById(inputId)?.focus());
            }
          }}
          testId="consult-choice"
        >
          {t.consult.other}
        </ChoiceButton>
      </div>
      {showText ? (
        <div className="mt-2 animate-fade">
          <label htmlFor={inputId} className="sr-only">
            {question === "when" && !picks.includes(OTHER)
              ? t.consult.datePick
              : t.consult.otherLabel(label)}
          </label>
          <input
            id={inputId}
            type={question === "when" && !picks.includes(OTHER) ? "date" : "text"}
            maxLength={100}
            value={text}
            placeholder={t.consult.otherPlaceholder}
            onChange={(event) => actions.setConsultText(question, event.target.value)}
            className={textField}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

/** 段階のタブ：誰と行く？ › いつ？ › どこへ？ › … › 確認。答えた段階にはしるしを付ける */
function StepTabs() {
  const t = useT();
  const actions = useActions();
  const step = useApp((state) => state.consult.step);
  const answers = useApp((state) => state.consult.answers);
  return (
    <nav aria-label={t.consult.stepsLabel} data-testid="consult-steps">
      <ol className="flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]">
        {CONSULT_STEPS.map((id, index) => {
          const current = id === step;
          const done = STEP_QUESTIONS[id].some((question) =>
            isAnswered(answers[question], question),
          );
          return (
            <li key={id} className="flex shrink-0 items-center gap-1">
              {index === 0 ? null : (
                <ChevronRight aria-hidden="true" className="size-3.5 text-wood-500" />
              )}
              <button
                type="button"
                aria-current={current ? "step" : undefined}
                onClick={() => actions.setConsultStep(id)}
                className={`flex min-h-8 items-center gap-1 whitespace-nowrap rounded-full border px-3 font-bold text-xs transition sm:text-sm ${
                  current
                    ? "border-yamabuki-400 bg-yamabuki-400 text-ink shadow-soft"
                    : "border-line-strong bg-white/70 text-ink-soft hover:bg-white"
                }`}
              >
                {done && !current ? (
                  <Check aria-hidden="true" className="size-3.5 text-emerald-700" />
                ) : null}
                {t.consult.steps[id]}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** 確認の段階：選んだ内容の一覧 */
function Summary() {
  const t = useT();
  const actions = useActions();
  const answers = useApp((state) => state.consult.answers);
  const today = todayInJapan();
  return (
    <dl className="grid gap-1 sm:grid-cols-2" data-testid="consult-summary">
      {(Object.keys(CONSULT_OPTIONS) as ConsultQuestion[]).map((question) => {
        const text = answerText(question, answers[question], t.consult.wording, today);
        const step = CONSULT_STEPS.find((id) => STEP_QUESTIONS[id].includes(question));
        return (
          <div
            key={question}
            className="flex items-baseline gap-2 rounded-card border border-line bg-white/70 px-3 py-1.5 text-sm"
          >
            <dt className="shrink-0 font-bold text-ink-soft">{t.consult.labels[question]}</dt>
            <dd className="min-w-0 flex-1 text-ink">
              {text === null ? (
                <button
                  type="button"
                  className="text-ink-soft underline underline-offset-2"
                  onClick={() => step !== undefined && actions.setConsultStep(step)}
                >
                  {t.consult.unanswered}
                </button>
              ) : (
                text
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const footButton =
  "inline-flex min-h-11 items-center gap-1 rounded-full px-4 font-bold shadow-soft transition disabled:cursor-not-allowed disabled:opacity-60";

/** 選んで進める相談の本体（会話の窓の中に出す） */
export function ConsultPanel() {
  const t = useT();
  const actions = useActions();
  const step = useApp((state) => state.consult.step);
  const answers = useApp((state) => state.consult.answers);
  const ready = useApp((state) => state.session.status === "ready" && !state.session.streaming);
  const questions = STEP_QUESTIONS[step];
  const canSend = ready && hasAnyAnswer(answers);
  const go = (next: ConsultStep) => {
    actions.setConsultStep(next);
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLElement>("[data-testid='consult'] [data-dialogue-focus]")?.focus(),
    );
  };

  return (
    <section aria-label={t.consult.title} className="space-y-3" data-testid="consult">
      <StepTabs />
      <div className="min-h-24 space-y-3">
        {step === "confirm" ? (
          <Summary />
        ) : (
          questions.map((question) => (
            <Question key={question} question={question} showLabel={questions.length > 1} />
          ))
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className={`${footButton} border border-line-strong bg-white text-ink-soft`}
          disabled={step === CONSULT_STEPS[0]}
          onClick={() => go(previousStep(step))}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          {t.consult.back}
        </button>
        {step === "confirm" ? (
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              className={`${footButton} border-2 border-wood-700/30 bg-yamabuki-400 text-ink`}
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
        ) : (
          <button
            type="button"
            className={`${footButton} border-2 border-wood-700/30 bg-yamabuki-400 text-ink`}
            onClick={() => go(nextStep(step))}
            data-testid="consult-next"
          >
            {nextStep(step) === "confirm" ? t.consult.toConfirm : t.consult.next}
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </section>
  );
}
