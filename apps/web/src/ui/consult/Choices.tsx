import { Check, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { prefecturePick, REGIONS, type Region } from "../../state/consult";
import { useT } from "../../state/react";

// 聞き取りの部品：選択肢のつまみ、自由記述の欄、決定のボタン、人数の ＋/−、進み具合、都道府県の選択肢。
// 選択肢は、薄い木の色の帯に並べ、選んだものを藍色にする（押せる大きさは 44px 以上）。

/** 段階を移ったあと、その段階の最初の場所へ焦点を移す */
export function focusStep(): void {
  window.requestAnimationFrame(() =>
    document.querySelector<HTMLElement>("[data-testid='consult'] [data-dialogue-focus]")?.focus(),
  );
}

export function ChoiceGroup({
  label,
  hideLabel = false,
  note,
  children,
}: {
  label: string;
  hideLabel?: boolean;
  note?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className={hideLabel ? "sr-only" : "mb-1 font-bold text-ink-soft text-sm"}>
        {label}
        {note === undefined ? null : <span className="ml-2 font-normal text-xs">（{note}）</span>}
      </legend>
      <div className="flex flex-wrap gap-1 rounded-card bg-wood-100/80 p-1">{children}</div>
    </fieldset>
  );
}

export function Choice({
  pressed,
  onClick,
  icon,
  children,
  focusFirst = false,
}: {
  pressed: boolean;
  onClick: () => void;
  icon?: ReactNode;
  children: ReactNode;
  /** 段階を開いたとき、最初に焦点を置くか */
  focusFirst?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      data-testid="consult-choice"
      data-dialogue-focus={focusFirst ? "" : undefined}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 font-bold text-sm transition sm:text-base ${
        pressed
          ? "bg-ai-800 text-kinari-50 shadow-soft"
          : "text-ink hover:bg-white/80 active:bg-white"
      }`}
    >
      {pressed ? <Check aria-hidden="true" className="size-4 text-yamabuki-400" /> : icon}
      {children}
    </button>
  );
}

export const textField =
  "min-h-11 w-full rounded-card border-2 border-line-strong bg-white px-3 py-2 text-base text-ink shadow-inner placeholder:text-stone-500 focus:border-ai-500 focus:outline-none";

export const decideButton =
  "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border-2 border-wood-700/30 bg-yamabuki-400 px-5 font-bold text-ink shadow-soft transition hover:brightness-105 disabled:cursor-not-allowed disabled:border-transparent disabled:bg-stone-300 disabled:text-stone-600";

export function DecideRow({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <div className="mt-2 flex justify-end">
      <button
        type="button"
        className={decideButton}
        disabled={disabled}
        onClick={onClick}
        data-testid="consult-decide"
      >
        {t.consult.decide}
        <ChevronRight aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

/** 地方を選んだら、その中の都道府県でもしぼれる（地方が1県だけのところは出さない） */
export function PrefecturePicks({
  picks,
  onPick,
}: {
  picks: readonly string[];
  onPick: (value: string) => void;
}) {
  const t = useT();
  const regions = (Object.keys(REGIONS) as Region[]).filter(
    (region) => picks.includes(region) && REGIONS[region].length > 1,
  );
  if (regions.length === 0) return null;
  return (
    <div className="mt-2 animate-fade space-y-2">
      {regions.map((region) => (
        <ChoiceGroup
          key={region}
          label={t.consult.prefecturesLabel(t.consult.options.destination[region])}
        >
          {REGIONS[region].map((code) => {
            const value = prefecturePick(code);
            return (
              <Choice key={code} pressed={picks.includes(value)} onClick={() => onPick(value)}>
                {t.consult.prefectures[code]}
              </Choice>
            );
          })}
        </ChoiceGroup>
      ))}
    </div>
  );
}

/** 上の段：＜ 進み具合 ＞。done は、それぞれの段階を色で塗るか */
export function StepProgress({
  label,
  index,
  done,
  backDisabled = false,
  forwardDisabled,
  onBack,
  onForward,
}: {
  label: string;
  index: number;
  done: readonly boolean[];
  backDisabled?: boolean;
  forwardDisabled: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  const t = useT();
  const arrow =
    "grid size-10 shrink-0 place-items-center rounded-full border-2 border-line-strong bg-white text-ink shadow-soft transition hover:border-yamabuki-400 disabled:cursor-not-allowed disabled:opacity-30";
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={arrow}
        aria-label={t.consult.back}
        disabled={backDisabled}
        onClick={onBack}
        data-testid="consult-back"
      >
        <ChevronLeft aria-hidden="true" className="size-5" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline justify-between gap-2 font-bold text-sm">
          <span className="text-ink">{label}</span>
          <span className="text-ink-soft text-xs" data-testid="consult-progress">
            {t.consult.progress(index + 1, done.length)}
          </span>
        </p>
        <ol aria-hidden="true" className="mt-1 flex gap-1">
          {done.map((filled, at) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: 目盛りは位置そのもの
              key={at}
              className={`h-1.5 flex-1 rounded-full ${
                at === index ? "bg-yamabuki-400" : filled ? "bg-ai-700" : "bg-wood-200"
              }`}
            />
          ))}
        </ol>
      </div>
      <button
        type="button"
        className={arrow}
        aria-label={t.consult.forward}
        disabled={forwardDisabled}
        onClick={onForward}
        data-testid="consult-forward"
      >
        <ChevronRight aria-hidden="true" className="size-5" />
      </button>
    </div>
  );
}

/** 「その他」を選んだときの自由記述の欄 */
export function OtherField({
  id,
  label,
  placeholder,
  value,
  onChange,
  onDecide,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (text: string) => void;
  onDecide: () => void;
}) {
  return (
    <div className="mt-2 animate-fade">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="text"
        maxLength={100}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && value.trim() !== "") {
            event.preventDefault();
            onDecide();
          }
        }}
        className={textField}
      />
    </div>
  );
}

/** 人数の ＋/−（1行） */
export function Counter({
  label,
  value,
  min,
  max,
  valueText,
  decreaseLabel,
  increaseLabel,
  onStep,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  valueText: string;
  decreaseLabel: string;
  increaseLabel: string;
  onStep: (delta: 1 | -1) => void;
}) {
  const round =
    "grid size-11 place-items-center rounded-full border-2 border-line-strong bg-white text-ink shadow-soft transition hover:border-yamabuki-400 disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center justify-between gap-3 rounded-card bg-white/70 px-3 py-1">
      <span className="font-bold text-ink text-sm sm:text-base">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={round}
          aria-label={decreaseLabel}
          disabled={value <= min}
          onClick={() => onStep(-1)}
        >
          <Minus aria-hidden="true" className="size-4" />
        </button>
        <output aria-live="polite" className="w-10 text-center font-bold text-ink text-lg">
          {valueText}
        </output>
        <button
          type="button"
          className={round}
          aria-label={increaseLabel}
          disabled={value >= max}
          onClick={() => onStep(1)}
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}
