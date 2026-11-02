import { STAFF_IDS, type StaffId } from "@matsuri-ikoka/schema";
import { useApp, useT } from "../state/react";
import type { StaffState } from "../state/types";

// スタッフの状態（待機・移動・作業・戻る）と吹き出しを 2D で出す。
// 3D がないとき・動きを減らす設定のときは、これが店内の見た目の主になる。

/**
 * 見取り図の上の位置（%）。持ち場は固定、待機の位置はカウンターの近く。
 * 右の3割は、クエストの掲示板と小話のカードを置くために空けておく。
 */
const POSITIONS: Record<StaffId, { home: [number, number]; post: [number, number] }> = {
  concierge: { home: [41, 76], post: [41, 76] },
  researcher: { home: [13, 64], post: [15, 36] },
  scout: { home: [27, 55], post: [38, 36] },
  planner: { home: [58, 60], post: [58, 36] },
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
  const summarize = useStaffSummary(true);
  const furniture: [StaffId, string][] = [
    ["researcher", "left-[5%] w-[20%]"],
    ["scout", "left-[28%] w-[20%]"],
    ["planner", "left-[48%] w-[20%]"],
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
      <div className="absolute bottom-[3%] left-[19%] w-[44%] rounded-md border-2 border-wood-900/40 bg-wood-500 px-2 py-1 text-center font-bold text-white text-xs shadow">
        {t.staff.posts.concierge}
      </div>

      {STAFF_IDS.map((id) => {
        const state = staff[id];
        const [x, y] = atPost(state) ? POSITIONS[id].post : POSITIONS[id].home;
        return (
          <div
            key={id}
            className="absolute flex w-[29%] max-w-48 flex-col items-center sm:w-[23%] transition-[left,top] duration-[900ms] ease-in-out"
            style={{ left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)" }}
            data-testid={`staff-${id}`}
            data-phase={state.phase}
          >
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
                  <p className="mt-0.5 font-medium text-ink">「{state.bubble}」</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
