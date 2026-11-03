import { ChevronLeft, ChevronRight } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  addDays,
  type DateRange,
  monthWeeks,
  selectableDay,
  shiftMonth,
} from "../../state/consult";
import { useT } from "../../state/react";

// 行きと帰りの日を選ぶカレンダー。1つめに押した日が行き、2つめが帰り（同じ日なら日帰り）。
// 行きより前の日を押すと、行きの選び直しになる。矢印キーで日を動かし、Enter で選ぶ。

const KEY_DAYS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

export function RangeCalendar({
  today,
  range,
  onRange,
  autoFocus,
}: {
  today: string;
  range: DateRange | undefined;
  onRange: (from: string, to: string) => void;
  /** 開いたらすぐ、カレンダーの日に焦点を置くか（「日付を指定」を押したとき） */
  autoFocus: boolean;
}) {
  const t = useT();
  const words = t.consult.calendar;
  /** 行きだけを選んで、帰りを待っている日 */
  const [start, setStart] = useState<string | null>(null);
  const [active, setActive] = useState(range?.from ?? today);
  const [month, setMonth] = useState(active.slice(0, 7));
  const grid = useRef<HTMLTableElement>(null);
  const wantFocus = useRef(autoFocus);

  // 開いたとき（autoFocus）と矢印で動かしたあとは、その日に焦点を置く
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${active}"]`)?.focus();
  }, [active]);

  const choose = (date: string) => {
    if (!selectableDay(date, today, start)) return;
    setActive(date);
    if (start === null || date < start) {
      setStart(date);
      return;
    }
    setStart(null);
    onRange(start, date);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = KEY_DAYS[event.key];
    if (delta === undefined) return;
    // 日を動かすだけにする（店の中の旅人は動かさない）
    event.preventDefault();
    event.stopPropagation();
    const next = addDays(active, delta);
    if (next < today) return;
    wantFocus.current = true;
    setActive(next);
    setMonth(next.slice(0, 7));
  };

  const inRange = (date: string) => {
    if (start !== null) return date === start;
    return range !== undefined && date >= range.from && date <= range.to;
  };
  const isEdge = (date: string) =>
    start !== null
      ? date === start
      : range !== undefined && (date === range.from || date === range.to);
  const thisMonth = today.slice(0, 7);
  const days = monthWeeks(month).flat();
  // Tab で入る日：選んでいる日がこの月になければ、この月の最初の選べる日
  const tabbable = days.some((day) => day.inMonth && day.date === active)
    ? active
    : days.find((day) => day.inMonth && selectableDay(day.date, today, start))?.date;

  return (
    <div
      className="mt-2 animate-fade rounded-panel border-2 border-wood-300 bg-washi p-3 shadow-soft"
      data-testid="consult-calendar"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          aria-label={words.previous}
          disabled={month <= thisMonth}
          onClick={() => setMonth(shiftMonth(month, -1))}
          className="grid size-10 place-items-center rounded-full bg-white text-ink shadow-soft transition hover:bg-yamabuki-100 disabled:opacity-30"
        >
          <ChevronLeft aria-hidden="true" className="size-5" />
        </button>
        <p id="consult-calendar-month" aria-live="polite" className="font-bold text-ink text-lg">
          {words.month(month)}
        </p>
        <button
          type="button"
          aria-label={words.next}
          onClick={() => setMonth(shiftMonth(month, 1))}
          className="grid size-10 place-items-center rounded-full bg-white text-ink shadow-soft transition hover:bg-yamabuki-100"
        >
          <ChevronRight aria-hidden="true" className="size-5" />
        </button>
      </div>
      <p className="mb-2 text-center text-ink-soft text-xs sm:text-sm">
        {start === null ? words.hint : words.hintEnd}
      </p>
      <table ref={grid} aria-labelledby="consult-calendar-month" className="w-full table-fixed">
        <thead>
          <tr>
            {words.weekdays.map((weekday, index) => (
              <th
                key={weekday}
                scope="col"
                className={`pb-1 text-center font-bold text-xs ${
                  index === 0 ? "text-shu-600" : index === 6 ? "text-ai-600" : "text-ink-soft"
                }`}
              >
                {weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthWeeks(month).map((week) => (
            <tr key={week[0]?.date}>
              {week.map((day, index) => {
                if (!day.inMonth) return <td key={day.date} />;
                const enabled = selectableDay(day.date, today, start);
                const selected = inRange(day.date);
                const edge = isEdge(day.date);
                return (
                  <td key={day.date} className="p-0.5">
                    <button
                      type="button"
                      data-date={day.date}
                      tabIndex={day.date === tabbable ? 0 : -1}
                      disabled={!enabled}
                      aria-label={words.day(day.date)}
                      aria-pressed={selected}
                      onClick={() => choose(day.date)}
                      onFocus={() => setActive(day.date)}
                      onKeyDown={onKeyDown}
                      className={`grid aspect-square w-full min-h-9 place-items-center rounded-full font-bold text-sm transition disabled:cursor-not-allowed disabled:opacity-30 ${
                        edge
                          ? "bg-shu-500 text-white shadow-soft"
                          : selected
                            ? "bg-yamabuki-200 text-ink"
                            : `bg-white/80 hover:bg-yamabuki-100 ${
                                index === 0
                                  ? "text-shu-600"
                                  : index === 6
                                    ? "text-ai-600"
                                    : "text-ink"
                              }`
                      } ${day.date === today ? "ring-2 ring-ai-500" : ""}`}
                    >
                      {Number(day.date.slice(8, 10))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
