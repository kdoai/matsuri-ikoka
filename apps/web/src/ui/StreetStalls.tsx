import type { GuideStall } from "@matsuri-ikoka/schema";
import { MessageCircle, Tent, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useAccountUser } from "../account/useAccountUser";
import { formatDateTime } from "../i18n";
import { unreadNotices } from "../state/guide";
import { useActions, useApp, useT } from "../state/react";
import { buttonPrimary, buttonSecondary, SourceLink } from "./common";
import { KeyCap } from "./Hud";
import { Portrait } from "./Portraits";
import { TripDayCard } from "./TripDay";

// 縁日の通りの、ガイドの屋台。旅のことは、すべてこのガイド1人に尋ねればよく、屋台を種類で分けない。
// 3D に出ること（提灯が灯っているか＝新しい知らせ）は、ここですべて文字で読める。
// 3D を使わない画面では、この屋台の正面が通りの主役になる。

/**
 * 見回りを頼む・止める。旅が終わったら出さない。
 * 見回りはログインして残した旅だけを探すので、ログインしていなければボタンを出さず、ログインすれば頼めることを出す
 * （ログインを用意していない環境では、頼めないので出さない）
 */
export function WatchControl() {
  const t = useT();
  const actions = useActions();
  const { enabled: loginOffered, user } = useAccountUser();
  const availability = useApp((state) => state.guide.availability);
  const phase = useApp((state) => state.guide.phase);
  const watch = useApp((state) => state.guide.watch);
  const watchAvailable = useApp((state) => state.guide.watchAvailable);
  const busy = useApp((state) => (state.guide.streaming ? "streaming" : state.guide.busy));
  // 見回りが動かない環境では、頼めるように見せない（頼んでも、だれも見回らない）
  if (availability !== "ready" || phase === "after" || !watchAvailable) return null;
  if (user === null) {
    return loginOffered ? (
      <p
        className="rounded-xl border border-line bg-white/80 px-3 py-2 text-sm"
        data-testid="watch-login"
      >
        {t.street.watchNeedsLogin}
      </p>
    ) : null;
  }
  const on = watch?.status === "active";
  // 項目がなければ声をかける
  const reminders = watch?.reminders !== false;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white/80 px-3 py-2"
      data-testid="watch-control"
      data-watching={on}
    >
      <p className="min-w-0 flex-1 text-sm">{on ? t.street.watchOn : t.street.watchOff}</p>
      <button
        type="button"
        className={buttonSecondary}
        disabled={busy !== null}
        onClick={() => void actions.setGuideWatch(on ? "stop" : "start")}
      >
        {on ? t.street.watchStop : t.street.watchStart}
      </button>
      {on ? (
        <div className="flex w-full flex-wrap items-center gap-2" data-testid="reminders-control">
          <p className="min-w-0 flex-1 text-xs text-ink-soft">
            {reminders ? t.street.remindersOn : t.street.remindersOff}
          </p>
          <button
            type="button"
            className={buttonSecondary}
            disabled={busy !== null}
            onClick={() => void actions.setGuideWatch(reminders ? "reminders_off" : "reminders_on")}
          >
            {reminders ? t.street.remindersStop : t.street.remindersStart}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 最後の決める操作の結果と、直す前の旅程に戻すボタン。
 * 戻すボタンは、結果の文を閉じたあとも、戻せる版があるあいだは出す
 */
export function GuideOutcomeNote() {
  const t = useT();
  const actions = useActions();
  const outcome = useApp((state) => state.guide.outcome);
  const revertTo = useApp((state) => state.guide.revertTo);
  const busy = useApp((state) => (state.guide.streaming ? "streaming" : state.guide.busy));
  if (outcome === null && revertTo === null) return null;
  const text = (() => {
    if (outcome === null) return null;
    switch (outcome.kind) {
      case "applied":
        return t.street.outcome.applied(outcome.diff.toVersion);
      case "reverted":
        return t.street.outcome.reverted(outcome.diff.toVersion);
      default:
        return t.street.outcome[outcome.kind];
    }
  })();
  return (
    <div
      className="rounded-xl border-2 border-ai-700/40 bg-white/80 px-3 py-2"
      data-testid="guide-outcome"
      data-outcome={outcome?.kind ?? "none"}
    >
      {text === null ? null : (
        <p role="status" className="text-sm">
          {text}
        </p>
      )}
      {revertTo === null ? null : (
        <button
          type="button"
          className={`${buttonSecondary} ${text === null ? "" : "mt-2"}`}
          disabled={busy !== null}
          data-testid="guide-revert"
          onClick={() => void actions.revertGuideChange()}
        >
          {t.street.revert}
        </button>
      )}
    </div>
  );
}

/** 組み直しの案の、承認と却下のボタン。ガイドが返事を流している間は押せない（返事の途中の相談では断られる） */
function ProposalActions({ proposalId }: { proposalId: string }) {
  const t = useT();
  const actions = useActions();
  const blocked = useApp((state) => state.guide.busy !== null || state.guide.streaming);
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <button
        type="button"
        className={buttonPrimary}
        disabled={blocked}
        data-testid="proposal-approve"
        onClick={() => void actions.decideProposal(proposalId, "approve")}
      >
        {t.street.approve}
      </button>
      <button
        type="button"
        className={buttonSecondary}
        disabled={blocked}
        data-testid="proposal-reject"
        onClick={() => void actions.decideProposal(proposalId, "reject")}
      >
        {t.street.reject}
      </button>
    </div>
  );
}

/**
 * 知らせに結びつかない組み直しの案（会話で頼んだ変更など）。知らせの上に出す。
 * 知らせに結びつく案は、その知らせの下に出す
 */
function UnlinkedProposals() {
  const t = useT();
  const proposals = useApp((state) => state.guide.proposals);
  const notices = useApp((state) => state.guide.notices);
  const unlinked = useMemo(
    () =>
      proposals.filter((proposal) => !notices.some((notice) => notice.proposalId === proposal.id)),
    [proposals, notices],
  );
  if (unlinked.length === 0) return null;
  return (
    <section data-testid="stall-proposals" aria-label={t.street.proposalsTitle}>
      <h3 className="mb-1 font-bold text-ai-800">{t.street.proposalsTitle}</h3>
      <ul className="space-y-2">
        {unlinked.map((proposal) => (
          <li
            key={proposal.id}
            className="rounded-xl border-2 border-ai-700/40 bg-white/80 px-3 py-2"
            data-testid="stall-proposal"
          >
            <p className="text-sm">{t.street.proposalNote(proposal.summary)}</p>
            <ProposalActions proposalId={proposal.id} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 届いた知らせ・組み直しの案・見回り。どこから開いても、同じ1つの中身を出す */
function GuideBoardBody() {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const notices = useApp((state) => state.guide.notices);
  const proposals = useApp((state) => state.guide.proposals);
  return (
    <div className="space-y-3">
      {/* 旅の当日は、次の予定・出発・帰りの最終を最初に見せる */}
      <TripDayCard />
      <GuideOutcomeNote />
      <UnlinkedProposals />
      {notices.length > 0 ? (
        <section data-testid="stall-notices" aria-label={t.street.noticesTitle}>
          <h3 className="mb-1 font-bold text-shu-700">{t.street.noticesTitle}</h3>
          <ul className="space-y-2">
            {notices.map((notice) => {
              const proposal = proposals.find((item) => item.id === notice.proposalId);
              return (
                <li
                  key={notice.id}
                  className="rounded-xl border-2 border-shu-600/50 bg-white/80 px-3 py-2"
                >
                  <p className="font-bold">{notice.summary}</p>
                  <p className="text-ink-soft text-sm">
                    {t.street.noticeChecked(formatDateTime(notice.checkedAt, locale))}
                  </p>
                  {proposal === undefined ? null : (
                    <div className="mt-1" data-testid="stall-proposal">
                      <p className="text-sm">{t.street.proposalNote(proposal.summary)}</p>
                      <ProposalActions proposalId={proposal.id} />
                    </div>
                  )}
                  <ul className="mt-1 space-y-0.5">
                    {notice.sources.map((source) => (
                      <li key={source.url}>
                        <SourceLink source={source} />
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="text-ink-soft text-sm" data-testid="stall-no-notices">
          {t.street.noNotices}
        </p>
      )}
      <WatchControl />
    </div>
  );
}

/** 提灯の列。灯っているのは新しい知らせがあるとき。同じことを文字でも出すので、飾りは読み上げない */
function Lanterns({ lit }: { lit: boolean }) {
  return (
    <div aria-hidden="true" className="relative flex justify-around px-4">
      <span className="absolute inset-x-2 top-0 h-0.5 bg-wood-700" />
      {[0, 1, 2, 3, 4].map((index) => (
        <span key={index} className="relative flex flex-col items-center">
          <span className="h-2 w-px bg-wood-700" />
          <span
            className={`h-10 w-7 rounded-[45%] border-wood-800 border-y-4 sm:h-12 sm:w-9 ${
              lit
                ? "bg-shu-500 shadow-[0_0_22px_8px_rgb(233_181_40/0.6)]"
                : "bg-shu-600 shadow-[0_0_14px_3px_rgb(233_181_40/0.3)]"
            }`}
          />
        </span>
      ))}
    </div>
  );
}

/**
 * ガイドの屋台の正面（3D を使わない画面の主役）。提灯と紅白の幕の下に、ガイドが立っている。
 * 話しかけると会話の窓が開き、旅のことは何でもここで尋ねられる。知らせはカウンターの上に並べる
 */
export function GuideStallFront({ onTalk }: { onTalk: () => void }) {
  const t = useT();
  const notices = useApp((state) => state.guide.notices);
  const unread = useMemo(() => unreadNotices({ notices }).length, [notices]);
  return (
    <section aria-labelledby="guide-stall-title" data-testid="guide-stall" className="text-ink">
      <Lanterns lit={unread > 0} />
      {/* 屋根の紅白の幕。下の縁は波の形にする */}
      <div
        aria-hidden="true"
        className="mt-2 h-12 rounded-t-2xl border-2 border-wood-800 sm:h-14"
        style={{
          background:
            "repeating-linear-gradient(90deg, var(--color-shu-500) 0 36px, var(--color-kinari-50) 36px 72px)",
        }}
      />
      <div
        aria-hidden="true"
        className="h-4"
        style={{
          background:
            "radial-gradient(circle at 18px 0, var(--color-shu-500) 17px, transparent 18px) 0 0 / 72px 16px repeat-x, radial-gradient(circle at 18px 0, var(--color-kinari-50) 17px, transparent 18px) 36px 0 / 72px 16px repeat-x",
        }}
      />
      {/* 看板 */}
      <div className="-mt-2 relative z-10 mx-auto w-fit rounded-lg border-2 border-wood-800 bg-wood-700 px-5 py-1.5 shadow-soft">
        <h2
          id="guide-stall-title"
          className="flex items-center gap-2 font-bold text-kinari-50 text-lg tracking-widest sm:text-xl"
        >
          <Tent aria-hidden="true" className="size-5 text-yamabuki-400" />
          {t.street.stallName}
        </h2>
      </div>
      {/* 屋台の中：柱のあいだにガイドが立つ */}
      <div className="-mt-4 grid grid-cols-[0.75rem_1fr_0.75rem] sm:grid-cols-[1rem_1fr_1rem]">
        <span aria-hidden="true" className="bg-wood-700" />
        <div className="bg-wood-800/60 px-3 pt-8 pb-3 sm:px-6">
          <div className="flex items-end gap-3 sm:gap-5">
            <Portrait speaker="concierge" className="size-20 shrink-0 sm:size-28" />
            <div className="washi mb-2 min-w-0 flex-1 rounded-2xl border-2 border-line-strong px-3 py-2 shadow-soft">
              <p className="font-bold leading-relaxed sm:text-lg">{t.street.stallGreeting}</p>
              {unread > 0 ? (
                <p className="mt-0.5 font-bold text-shu-700 text-sm" data-testid="street-unread">
                  {t.street.unreadNotices(unread)}
                </p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onTalk}
            data-testid="guide-stall-talk"
            className={`${buttonPrimary} mt-3 w-full`}
          >
            <MessageCircle aria-hidden="true" className="size-5" />
            {t.street.talk}
            <KeyCap small>E</KeyCap>
          </button>
        </div>
        <span aria-hidden="true" className="bg-wood-700" />
      </div>
      {/* カウンター：知らせと案を並べる */}
      <div className="rounded-b-2xl border-2 border-wood-800 border-t-8 bg-kinari-50 px-4 py-3 shadow-lift">
        <GuideBoardBody />
      </div>
    </section>
  );
}

/** ガイドの屋台の窓（3D の通りで屋台に触れたとき・案内されたとき・知らせを開いたとき） */
export function GuideBoard({
  stall,
  onClose,
}: {
  /** 3D の通りで触れた・案内された屋台（どの屋台でも中身は同じ）。上の段から開いたときは null */
  stall: GuideStall | null;
  onClose: () => void;
}) {
  const t = useT();
  const actions = useActions();
  const heading = useRef<HTMLHeadingElement>(null);

  // 開いたら見出しへ、閉じたら開く前の場所へ焦点を移す
  useEffect(() => {
    const before = document.activeElement;
    heading.current?.focus();
    return () => {
      // 開くのに使ったボタンが消えていたら、知らせのボタンか話しかけるボタンへ
      const back =
        before instanceof HTMLElement && before.isConnected
          ? before
          : document.querySelector<HTMLElement>(
              '[data-testid="stall-list-button"], [data-testid="guide-bar"] button',
            );
      back?.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      aria-labelledby="stall-title"
      className="washi flex h-full max-h-full animate-pop flex-col rounded-panel border-2 border-line-strong text-ink shadow-lift"
      data-testid="stall-window"
      data-stall={stall ?? "board"}
    >
      <header className="flex items-center gap-2 border-line border-b border-dashed px-4 py-3">
        <Tent aria-hidden="true" className="size-6 shrink-0 text-wood-700" />
        <h2
          id="stall-title"
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 font-bold text-lg outline-none"
        >
          {t.street.stallName}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.street.closeStall}
          className="grid size-10 shrink-0 place-items-center rounded-full border border-line-strong bg-kinari-50 shadow-soft hover:bg-white"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <GuideBoardBody />
      </div>
      <footer className="border-line border-t border-dashed px-4 py-2">
        <button
          type="button"
          className={`${buttonPrimary} w-full`}
          onClick={() => actions.setGuideDialogue(true)}
        >
          <MessageCircle aria-hidden="true" className="size-4" />
          {t.street.askGuide}
        </button>
      </footer>
    </section>
  );
}
