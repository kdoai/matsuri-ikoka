import { Check, Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";

// 聞き取りの部品：選択肢のつまみ、自由記述の欄、決定のボタン、人数の ＋/−。
// 選択肢は、薄い木の色の帯に並べ、選んだものを藍色にする（押せる大きさは 44px 以上）。

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
