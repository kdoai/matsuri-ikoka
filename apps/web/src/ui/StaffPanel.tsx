import { STAFF_IDS, type StaffId } from "@matsuri-ikoka/schema";
import { ArrowRight, ClipboardList, Clock, Mail } from "lucide-react";
import { useApp, useT } from "../state/react";
import { staffActivity, turnRelays } from "../state/relay";
import type { RelayEntry, StaffState } from "../state/types";
import { GameWindow } from "./GameWindow";
import { formatElapsed, useNow, useWaitClock } from "./waitClock";

// スタッフの状態（待機・移動・作業・戻る）と吹き出しを 2D で出す。
// 3D がないとき・動きを減らす設定のときは、これが店内の見た目の主になる。
// スタッフどうしの頼みと受け渡しも、見取り図の矢印と、文字の一覧（RelayLog）で読める。

/** この時間を過ぎたら、旅程づくりには時間がかかることを伝える */
const LONG_WAIT_MS = 20_000;

/** 見取り図の上の位置（%）。持ち場は固定、待機の位置はカウンターの近く */
const POSITIONS: Record<StaffId, { home: [number, number]; post: [number, number] }> = {
  concierge: { home: [52, 76], post: [52, 76] },
  researcher: { home: [24, 62], post: [18, 36] },
  scout: { home: [38, 56], post: [50, 36] },
  planner: { home: [72, 62], post: [82, 36] },
};

/** スタッフの見分け：法被の色と頭文字 */
export const STAFF_LOOK: Record<StaffId, { initial: string; badge: string }> = {
  concierge: { initial: "案", badge: "bg-ai-700 text-white ring-ai-900" },
  researcher: { initial: "調", badge: "bg-shu-600 text-white ring-shu-700" },
  scout: { initial: "周", badge: "bg-emerald-700 text-white ring-emerald-900" },
  planner: { initial: "旅", badge: "bg-wood-600 text-white ring-wood-800" },
};

function atPost(staff: StaffState): boolean {
  return staff.phase === "walking" || staff.phase === "working";
}

function floorPosition(id: StaffId, staff: StaffState): [number, number] {
  return atPost(staff) ? POSITIONS[id].post : POSITIONS[id].home;
}

/** 頼みと受け渡しの1件を文にする（辞書の決まった型） */
export function useRelayLine() {
  const t = useT();
  return (entry: RelayEntry): string => {
    const from = t.staff.names[entry.from];
    const to = t.staff.names[entry.to];
    switch (entry.kind) {
      case "request":
        return t.relay.requestLine(from, to, t.staff.tasks[entry.task]);
      case "handoff":
        return t.relay.handoffLine(from, to, t.relay.items[entry.task]);
      case "redo_request":
      case "redo_accept": {
        const subject =
          entry.subject === undefined
            ? t.staff.tasks[entry.task]
            : t.relay.redoSubjects[entry.subject];
        return entry.kind === "redo_request"
          ? t.relay.redoRequestLine(from, to, subject)
          : t.relay.redoAcceptLine(from, to, subject);
      }
    }
  };
}

/** 吹き出しを出すか（作業に向かう・作業中のときだけ） */
function showsBubble(staff: StaffState): boolean {
  return staff.bubble !== null && staff.phase !== "idle" && staff.phase !== "returning";
}

/**
 * スタッフのいまの様子を文にする。detailed のときは動き（資料をめくる など）まで書く。
 * 一覧では短く、見取り図の読み上げでは詳しく出す。
 */
function useStaffSummary(detailed: boolean) {
  const t = useT();
  return (id: StaffId, staff: StaffState): string => {
    if (id === "concierge" && staff.motion === "talk") {
      return t.staff.motions.talk;
    }
    if (!detailed && (staff.motion === "carry" || staff.motion === "stamp")) {
      return t.staff.motions[staff.motion];
    }
    const parts: string[] = [t.staff.phases[staff.phase]];
    if (staff.phase === "walking" || staff.phase === "working") {
      if (detailed && staff.task !== null) {
        parts.push(t.staff.tasks[staff.task]);
      }
      if (staff.tool !== null) {
        parts.push(t.staff.tools[staff.tool]);
      } else if (!detailed && staff.task !== null) {
        parts.push(t.staff.tasks[staff.task]);
      }
    }
    const motion = t.staff.motions[staff.motion];
    if (detailed && motion !== "" && staff.phase !== "idle") {
      parts.push(motion);
    }
    return parts.join("・");
  };
}

function Badge({ id, size = "md" }: { id: StaffId; size?: "sm" | "md" }) {
  const look = STAFF_LOOK[id];
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full font-bold ring-2 ${look.badge} ${
        size === "md" ? "size-11 text-lg" : "size-8 text-sm"
      }`}
    >
      {look.initial}
    </span>
  );
}

/** 店内の見取り図。持ち場の家具と、スタッフの位置・吹き出し */
export function StaffFloor() {
  const t = useT();
  const staff = useApp((state) => state.staff);
  const relay = useApp((state) => state.relay);
  // 返答を待っている間だけ出す（終わったあとの矢印は残さない）
  const latest = useApp((state) =>
    state.session.streaming ? (turnRelays(state).at(-1) ?? null) : null,
  );
  const summarize = useStaffSummary(true);
  const furniture: [StaffId, string][] = [
    ["researcher", "left-[6%] w-[24%]"],
    ["scout", "left-[38%] w-[24%]"],
    ["planner", "left-[70%] w-[24%]"],
  ];
  return (
    <section
      aria-label={t.staff.sceneLabel}
      className="wood-floor relative h-full min-h-64 w-full overflow-hidden"
      data-testid="staff-floor"
    >
      {/* 壁と家具 */}
      <div className="absolute inset-x-0 top-0 h-[22%] bg-wood-700 shadow-[inset_0_-6px_0_rgb(0_0_0/0.15)]" />
      {furniture.map(([id, place]) => (
        <div
          key={id}
          className={`absolute top-[4%] ${place} rounded-md border-2 border-wood-900/40 bg-kinari-50/95 px-2 py-1 text-center font-bold text-wood-900 text-xs shadow`}
        >
          {t.staff.posts[id]}
        </div>
      ))}
      <div className="absolute bottom-[3%] left-[30%] w-[44%] rounded-md border-2 border-wood-900/40 bg-wood-500 px-2 py-1 text-center font-bold text-white text-xs shadow">
        {t.staff.posts.concierge}
      </div>

      {/* いちばん新しい頼みか受け渡しを、渡す人から受け取る人への矢印で出す（文字は RelayLog） */}
      {latest === null ? null : (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          data-testid="relay-arrow"
          data-kind={latest.kind}
        >
          <line
            key={latest.id}
            x1={floorPosition(latest.from, staff[latest.from])[0]}
            y1={floorPosition(latest.from, staff[latest.from])[1]}
            x2={floorPosition(latest.to, staff[latest.to])[0]}
            y2={floorPosition(latest.to, staff[latest.to])[1]}
            className={`animate-fade motion-reduce:animate-none ${
              latest.kind === "handoff" ? "stroke-shu-600" : "stroke-ai-700"
            }`}
            strokeWidth={3}
            strokeDasharray="8 6"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {STAFF_IDS.map((id) => {
        const state = staff[id];
        const [x, y] = floorPosition(id, state);
        const activity = staffActivity(id, state, relay);
        return (
          <div
            key={id}
            className="absolute flex w-[29%] max-w-48 flex-col items-center sm:w-[23%] transition-[left,top] duration-[900ms] ease-in-out motion-reduce:transition-none"
            style={{ left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)" }}
            data-testid={`staff-${id}`}
            data-phase={state.phase}
          >
            {activity === null ? null : (
              <span
                className="mb-0.5 rounded-full bg-yamabuki-400 px-2 font-bold text-ink text-xs shadow"
                data-testid="staff-status"
              >
                {t.relay.activities[activity]}
              </span>
            )}
            <Badge id={id} />
            <span className="mt-0.5 rounded bg-kinari-50/90 px-1.5 font-bold text-ink text-xs">
              {t.staff.names[id]}
            </span>
            <span className="sr-only">{summarize(id, state)}</span>
            {showsBubble(state) ? (
              <p
                key={state.bubble}
                className="mt-1 animate-fade rounded-xl border-2 border-ink/80 bg-white px-2 py-1 text-center font-medium text-ink text-xs leading-snug shadow-md"
              >
                {state.bubble}
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

/** スタッフの状態を文字で並べる。見取り図が吹き出しを出しているときは、吹き出しを重ねて出さない */
export function StaffList({ showBubbles }: { showBubbles: boolean }) {
  const t = useT();
  const staff = useApp((state) => state.staff);
  const summarize = useStaffSummary(false);
  return (
    <section aria-label={t.staff.title} className="px-1" data-testid="staff-list">
      <h2 className="sr-only">{t.staff.title}</h2>
      <ul className="grid grid-cols-2 gap-1.5 lg:grid-cols-4">
        {STAFF_IDS.map((id) => {
          const state = staff[id];
          return (
            <li
              key={id}
              className="flex min-w-0 items-center gap-2 rounded-lg bg-kinari-50 px-2 py-1 ring-1 ring-kinari-300"
            >
              <Badge id={id} size="sm" />
              <div className="min-w-0 text-xs leading-snug">
                <p>
                  <span className="mr-1 font-bold text-ink">{t.staff.names[id]}</span>
                  <span className="text-ink-soft">{summarize(id, state)}</span>
                </p>
                {showBubbles && showsBubble(state) ? (
                  // 一覧の高さをそろえるため2行までにする（同じ文は会話欄の作業の記録にも出る）
                  <p
                    className="mt-0.5 line-clamp-2 font-medium text-ink"
                    title={state.bubble ?? ""}
                  >
                    「{state.bubble}」
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * 店内のようす：いま動いているスタッフだけを、短い文で出す（ゲームの画面の右上、狭い画面は左上）。
 * 3D の動きと吹き出しと同じ情報を、文字でも読めるようにする。返答を待っている間は経過時間も出す。
 * 全員のようすは会話の記録で読める。
 */
export function StaffActivity() {
  const t = useT();
  const staff = useApp((state) => state.staff);
  const streaming = useApp((state) => state.session.streaming);
  const relay = useApp((state) => state.relay);
  const relays = useApp((state) => turnRelays(state));
  const summarize = useStaffSummary(false);
  const busy = STAFF_IDS.filter(
    (id) => staff[id].phase !== "idle" || staffActivity(id, staff[id], relay) !== null,
  );
  const clock = useWaitClock(streaming, busy);
  const now = useNow(streaming || busy.length > 0);
  if (busy.length === 0) {
    return null;
  }
  const elapsed = clock.started === null ? null : now - clock.started;
  return (
    <GameWindow
      ariaLabel={t.activity.title}
      testId="staff-activity"
      title={
        <>
          <ClipboardList className="size-4" aria-hidden="true" />
          {t.activity.title}
        </>
      }
    >
      <ul className="space-y-2">
        {busy.map((id) => {
          const state = staff[id];
          const since = clock.staffStarted[id];
          const activity = staffActivity(id, state, relay);
          const phase =
            activity === null ? t.staff.phases[state.phase] : t.relay.activities[activity];
          // 吹き出しより、くわしい文があればそれを出す。
          // 吹き出しがなく、ようすが札と同じ言葉だけなら、下の行は出さない
          const detail = showsBubble(state) ? (state.detail ?? state.bubble) : summarize(id, state);
          return (
            <li
              key={id}
              className="rounded-xl bg-white px-2 py-1.5 shadow-sm ring-1 ring-wood-300/60"
            >
              <div className="flex items-center gap-2">
                <Badge id={id} size="sm" />
                <span className="min-w-0 flex-1 truncate font-bold text-base text-ink">
                  {t.staff.names[id]}
                </span>
                {since === undefined ? null : (
                  <span className="shrink-0 font-mono text-ink-soft text-xs tabular-nums">
                    {formatElapsed(now - since)}
                  </span>
                )}
                <span className="shrink-0 whitespace-nowrap rounded-full bg-yamabuki-400 px-2 py-0.5 font-bold text-ink text-xs">
                  {phase}
                </span>
              </div>
              {detail === null || detail === phase ? null : (
                <p
                  className={`mt-1 line-clamp-4 border-yamabuki-400 border-l-4 pl-2 text-xs leading-snug ${
                    showsBubble(state) ? "font-medium text-ink" : "text-ink-soft"
                  }`}
                >
                  {detail}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {streaming ? <RelayLog entries={relays} limit={4} /> : null}
      {elapsed === null ? null : (
        <p
          className="mt-2 inline-flex items-center gap-1 rounded-full border-2 border-wood-300 bg-white px-2.5 py-0.5 font-mono text-ink-soft text-xs tabular-nums"
          data-testid="waiting-elapsed"
        >
          <Clock className="size-3" aria-hidden="true" />
          {t.waiting.elapsed(formatElapsed(elapsed))}
        </p>
      )}
      {elapsed !== null && elapsed >= LONG_WAIT_MS ? (
        <p className="mt-1.5 text-ink-soft text-xs">{t.waiting.longWait}</p>
      ) : null}
    </GameWindow>
  );
}

/**
 * 頼みと受け渡しの一覧（文字の記録）。3D の向き・吹き出し・手紙の動きと同じことを文で読む。
 * 動きを減らす設定のときも、これで進み具合が分かる。limit を付けると新しいものだけを出す
 */
export function RelayLog({ entries, limit }: { entries: readonly RelayEntry[]; limit?: number }) {
  const t = useT();
  const line = useRelayLine();
  if (entries.length === 0) return null;
  const shown = limit === undefined ? entries : entries.slice(-limit);
  return (
    <section aria-label={t.relay.title} className="mt-2" data-testid="relay-log">
      <h3 className="font-bold text-ink-soft text-xs">{t.relay.title}</h3>
      <ol className="mt-1 space-y-0.5">
        {shown.map((entry) => (
          <li
            key={entry.id}
            className="flex items-start gap-1 text-ink text-xs leading-snug"
            data-kind={entry.kind}
          >
            {entry.kind === "handoff" ? (
              <Mail className="mt-0.5 size-3 shrink-0 text-shu-600" aria-hidden="true" />
            ) : (
              <ArrowRight className="mt-0.5 size-3 shrink-0 text-ai-700" aria-hidden="true" />
            )}
            <span>{line(entry)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
