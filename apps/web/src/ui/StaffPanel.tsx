import { STAFF_IDS, type StaffId } from "@matsuri-ikoka/schema";
import { ArrowRight, ClipboardList, Clock, Mail } from "lucide-react";
import { useApp, useT } from "../state/react";
import { staffActivity, turnRelays } from "../state/relay";
import type { RelayEntry, StaffState } from "../state/types";
import { GameWindow, windowScroll } from "./GameWindow";
import { staffDetailText, staffLineText } from "./text";
import { formatElapsed, useNow, useWaitClock } from "./waitClock";

// スタッフの状態（待機・移動・作業・戻る）と吹き出しを、文字の一覧で出す。
// 3D の店内に出ることは、ここと、頼みと受け渡しの文字の一覧（RelayLog）ですべて読める。

/** この時間を過ぎたら、旅程づくりには時間がかかることを伝える */
const LONG_WAIT_MS = 20_000;

/** スタッフの見分け：法被の色と頭文字 */
export const STAFF_LOOK: Record<StaffId, { initial: string; badge: string }> = {
  concierge: { initial: "案", badge: "bg-ai-700 text-white ring-ai-900" },
  researcher: { initial: "調", badge: "bg-shu-600 text-white ring-shu-700" },
  scout: { initial: "周", badge: "bg-emerald-700 text-white ring-emerald-900" },
  planner: { initial: "旅", badge: "bg-wood-600 text-white ring-wood-800" },
};

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
 * 一覧では短く出す。
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

/** スタッフの状態を文字で並べる。showBubbles のときは吹き出しの文も添える */
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
                {showBubbles && showsBubble(state) && state.bubble !== null ? (
                  // 一覧の高さをそろえるため2行までにする（同じ文は会話欄の作業の記録にも出る）
                  <p
                    className="mt-0.5 line-clamp-2 font-medium text-ink"
                    title={staffLineText(state.bubble, state.cue, t)}
                  >
                    {t.lines.quote(staffLineText(state.bubble, state.cue, t))}
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
      // 高さが足りないときは、豆知識（クイズ）の窓より先にこちらを縮めて、中でスクロールする
      className="min-h-[7.5rem] shrink-[100]"
      title={
        <>
          <ClipboardList className="size-4" aria-hidden="true" />
          {t.activity.title}
        </>
      }
    >
      <div className={windowScroll}>
        <ul className="space-y-2">
          {busy.map((id) => {
            const state = staff[id];
            const since = clock.staffStarted[id];
            const activity = staffActivity(id, state, relay);
            const phase =
              activity === null ? t.staff.phases[state.phase] : t.relay.activities[activity];
            // 吹き出しより、くわしい文があればそれを出す。
            // 吹き出しがなく、ようすが札と同じ言葉だけなら、下の行は出さない
            const detail = showsBubble(state) ? staffDetailText(state, t) : summarize(id, state);
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
      </div>
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
