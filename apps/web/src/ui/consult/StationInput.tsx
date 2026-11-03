import { TrainFront } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import stationsUrl from "../../../../../data/stations/stations.json?url";
import { useT } from "../../state/react";
import { decideButton, textField } from "./Choices";
import { type Station, type StationList, searchStations } from "./stations";

// 出発の駅の入力。打ちはじめたら、駅の一覧から候補を出す（↑↓で選び、Enter で決める。選んでいる候補は読み上げる）。
// 一覧にない駅名も、そのまま決められる。駅の一覧は、この段階を開いたときに初めて読む。

/** 駅の一覧の出典（公式のページ。作り方は docs/stations.md） */
const STATIONS_SOURCE_URL = "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html";

let loading: Promise<readonly Station[]> | null = null;

/** 駅の一覧を読む（1回だけ）。読めなければ空にして、書いた駅名をそのまま使う */
function loadStations(): Promise<readonly Station[]> {
  loading ??= fetch(stationsUrl)
    .then((res) => (res.ok ? (res.json() as Promise<StationList>) : { stations: [] }))
    .then((list) => (Array.isArray(list.stations) ? list.stations : []))
    .catch(() => {
      loading = null;
      return [];
    });
  return loading;
}

export function StationInput({
  value,
  onChange,
  onDecide,
}: {
  value: string;
  onChange: (text: string) => void;
  /** 駅を決めたら呼ぶ（次の段階へ進む） */
  onDecide: (text: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [stations, setStations] = useState<readonly Station[] | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  useEffect(() => {
    let alive = true;
    void loadStations().then((list) => {
      if (alive) setStations(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const matches = useMemo(
    () => (stations === null ? [] : searchStations(stations, value)),
    [stations, value],
  );
  const listId = `${id}-list`;
  const showList = open && value.trim() !== "" && matches.length > 0;

  const pick = (station: Station) => {
    const text = t.consult.station(station[0]);
    onChange(text);
    setOpen(false);
    onDecide(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) =>
        matches.length === 0 ? -1 : (current + step + matches.length) % matches.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = showList ? matches[highlight] : undefined;
      if (chosen !== undefined) pick(chosen);
      else if (value.trim() !== "") onDecide(value.trim());
    } else if (event.key === "Escape" && showList) {
      // 候補だけを閉じる（会話の窓は閉じない）
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const highlighted = showList ? matches[highlight] : undefined;
  let status: string | null = null;
  if (highlighted !== undefined) {
    status = `${t.consult.station(highlighted[0])} ${highlighted[1]}`;
  } else if (value.trim() !== "") {
    if (stations === null) status = t.consult.stationLoading;
    else if (matches.length === 0) status = t.consult.stationNone;
    else status = t.consult.stationCount(matches.length);
  }

  return (
    <div className="relative">
      <label htmlFor={id} className="mb-1 block font-bold text-ink-soft text-sm">
        {t.consult.stationLabel}
      </label>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <TrainFront
            aria-hidden="true"
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-5 text-wood-500"
          />
          <input
            id={id}
            type="text"
            autoComplete="off"
            maxLength={50}
            value={value}
            placeholder={t.consult.stationPlaceholder}
            aria-controls={listId}
            aria-describedby={`${id}-status`}
            onChange={(event) => {
              onChange(event.target.value);
              setOpen(true);
              setHighlight(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
            className={`${textField} pl-10`}
            data-dialogue-focus=""
            data-testid="consult-station"
          />
        </div>
        <button
          type="button"
          className={decideButton}
          disabled={value.trim() === ""}
          onClick={() => onDecide(value.trim())}
        >
          {t.consult.decide}
        </button>
      </div>
      <p id={`${id}-status`} aria-live="polite" className="sr-only">
        {status}
      </p>
      {showList ? (
        <ul
          id={listId}
          aria-label={t.consult.stationLabel}
          className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-64 overflow-y-auto rounded-card border-2 border-wood-300 bg-washi p-1 shadow-soft"
        >
          {matches.map((station, index) => (
            <li key={`${station[0]}-${station[1]}`}>
              <button
                type="button"
                // 候補は ↑↓ で選ぶので、Tab では止まらない。入力欄の焦点を外さずに選ぶ
                tabIndex={-1}
                aria-current={index === highlight ? "true" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(station)}
                className={`flex w-full items-baseline gap-2 rounded-xl px-3 py-2 text-left ${
                  index === highlight ? "bg-ai-800 text-kinari-50" : "text-ink hover:bg-white"
                }`}
              >
                <span className="font-bold">{t.consult.station(station[0])}</span>
                <span
                  className={`min-w-0 truncate text-xs ${
                    index === highlight ? "text-kinari-100" : "text-ink-soft"
                  }`}
                >
                  {station[1]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : value.trim() !== "" && stations !== null && matches.length === 0 ? (
        <p className="mt-1 text-ink-soft text-xs">{t.consult.stationNone}</p>
      ) : null}
      <p className="mt-1 text-[0.7rem] text-ink-soft" data-testid="consult-station-source">
        <a
          href={STATIONS_SOURCE_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={t.consult.stationSourceLink}
          className="underline decoration-dotted underline-offset-2 hover:text-ink"
        >
          {t.consult.stationSource}
        </a>
      </p>
    </div>
  );
}
