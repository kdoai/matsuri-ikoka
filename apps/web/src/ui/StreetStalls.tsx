import type { GuideStall } from "@matsuri-ikoka/schema";
import { MessageCircle, Tent, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useAccountUser } from "../account/useAccountUser";
import { formatDateTime } from "../i18n";
import { useActions, useApp, useT } from "../state/react";
import { buttonPrimary, buttonSecondary, SourceLink } from "./common";
import { TripDayCard } from "./TripDay";

// 縁日の通りの、ガイドの屋台。旅のことは、すべてこのガイド1人に尋ねればよく、屋台を種類で分けない。
// 3D に出ること（提灯が灯っているか＝新しい知らせ）は、ここですべて文字で読める。

/**
 * 見回りを頼む・止める。旅が終わったら出さない。
 * 見回りはログインして残した旅だけを探すので、ログインしていなければボタンを出さず、ログインすれば頼めることを出す
 * （ログインを用意していない環境では、頼めないので出さない）
 */
/** 旅が終わったら、付き添いと見回りの終わりと、残した旅を消せることを知らせる */
export function AfterTripNote() {
  const t = useT();
  const phase = useApp((state) => state.guide.phase);
  if (phase !== "after") return null;
  return (
    <p
      className="rounded-xl border border-line bg-white/80 px-3 py-2 text-sm"
      data-testid="after-trip"
    >
      {t.street.afterTrip}
    </p>
  );
}

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
      <AfterTripNote />
      <WatchControl />
    </div>
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
        {/* 3D の通りでも、旅の当日は次の予定・出発・帰りの最終を最初に見せる */}
        <TripDayCard />
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
