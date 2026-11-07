import { GUIDE_STALLS, type GuideStall } from "@matsuri-ikoka/schema";
import {
  BedDouble,
  CloudSun,
  Landmark,
  type LucideIcon,
  MessageCircle,
  Tent,
  TrainFront,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useAccountUser } from "../account/useAccountUser";
import { formatDateTime } from "../i18n";
import { litStalls, noticesOfStall } from "../state/guide";
import { useActions, useApp, useT } from "../state/react";
import { buttonPrimary, buttonSecondary, SourceLink } from "./common";
import { stallFacts } from "./stallFacts";

// 屋台の一覧と、屋台の窓。3D に出ること（提灯が灯っているか・屋台の中身）を、ここですべて文字で読める。
// 3D を使わない画面では、この一覧が通りの主役になる。

const STALL_ICONS: Record<GuideStall, LucideIcon> = {
  lodging: BedDouble,
  access: TrainFront,
  etiquette: Landmark,
  food: UtensilsCrossed,
  weather: CloudSun,
  headquarters: Tent,
};

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
        className="mt-3 rounded-xl border border-line bg-white/80 px-3 py-2 text-sm"
        data-testid="watch-login"
      >
        {t.street.watchNeedsLogin}
      </p>
    ) : null;
  }
  const on = watch?.status === "active";
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white/80 px-3 py-2"
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
 * 知らせに結びつかない組み直しの案（会話で頼んだ変更など）。どの屋台の窓でも、知らせの上に出す。
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

/** 屋台の一覧。提灯の絵は飾りで、灯っているかは「新しい知らせ」の文字でも分かる */
export function StallList() {
  const t = useT();
  const actions = useActions();
  const notices = useApp((state) => state.guide.notices);
  const lit = useMemo(() => litStalls({ notices }), [notices]);
  return (
    <>
      <ul className="grid gap-2 sm:grid-cols-2" data-testid="stall-list">
        {GUIDE_STALLS.map((stall) => {
          const Icon = STALL_ICONS[stall];
          const on = lit.includes(stall);
          return (
            <li key={stall}>
              <button
                type="button"
                data-testid={`stall-${stall}`}
                data-lit={on}
                onClick={() => actions.openStall(stall)}
                className={`flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 bg-white/90 px-3 py-2 text-left text-ink shadow-soft transition hover:border-yamabuki-400 ${
                  on ? "border-shu-600" : "border-line-strong"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`grid size-10 shrink-0 place-items-center rounded-full ${
                    on
                      ? "bg-shu-500 text-kinari-50 shadow-[0_0_16px_4px_rgb(233_181_40/0.55)]"
                      : "bg-kinari-200 text-wood-700"
                  }`}
                >
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-bold">{t.street.stalls[stall].title}</span>
                  <span className="block text-ink-soft text-sm">{t.street.stalls[stall].lead}</span>
                </span>
                {on ? (
                  <span className="shrink-0 rounded-full bg-shu-600 px-2 py-0.5 font-bold text-white text-xs">
                    {t.street.lit}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <WatchControl />
    </>
  );
}

/** 開いている屋台の窓。旅程と祭りのデータから出し、届いた知らせを上に出す */
export function StallWindow({ stall }: { stall: GuideStall }) {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const itinerary = useApp((state) => state.itinerary.current);
  const festivalId = itinerary?.mainFestivalId ?? null;
  const festival = useApp((state) =>
    festivalId === null ? null : (state.festivals[festivalId] ?? null),
  );
  const festivalLoading = useApp(
    (state) => festivalId !== null && state.festivalLoad[festivalId] === "loading",
  );
  const verify = useApp((state) => state.verify);
  const allNotices = useApp((state) => state.guide.notices);
  const proposals = useApp((state) => state.guide.proposals);
  const availability = useApp((state) => state.guide.availability);
  const notices = useMemo(
    () => noticesOfStall({ notices: allNotices }, stall),
    [allNotices, stall],
  );
  const facts = useMemo(
    () => stallFacts(stall, { itinerary, festival, festivalLoading, verify }, t, locale),
    [stall, itinerary, festival, festivalLoading, verify, t, locale],
  );
  const heading = useRef<HTMLHeadingElement>(null);

  // 開いたら見出しへ、閉じたら開く前の場所へ焦点を移す
  useEffect(() => {
    const before = document.activeElement;
    heading.current?.focus();
    return () => {
      // 開くのに使ったボタンが消えていたら（一覧から開いたとき）、一覧のボタンか話しかけるボタンへ
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
      if (event.key === "Escape") actions.closeStall();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions]);

  const Icon = STALL_ICONS[stall];
  return (
    <section
      aria-labelledby="stall-title"
      className="washi flex h-full max-h-full animate-pop flex-col rounded-panel border-2 border-line-strong text-ink shadow-lift"
      data-testid="stall-window"
      data-stall={stall}
    >
      <header className="flex items-center gap-2 border-line border-b border-dashed px-4 py-3">
        <Icon aria-hidden="true" className="size-6 shrink-0 text-wood-700" />
        <h2
          id="stall-title"
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 font-bold text-lg outline-none"
        >
          {t.street.stalls[stall].title}
        </h2>
        <button
          type="button"
          onClick={actions.closeStall}
          aria-label={t.street.closeStall}
          className="grid size-10 shrink-0 place-items-center rounded-full border border-line-strong bg-kinari-50 shadow-soft hover:bg-white"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-3">
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
        ) : null}
        <dl className="space-y-3">
          {facts.map((item) => (
            <div key={item.label}>
              <dt className="font-bold text-wood-700">{item.label}</dt>
              {item.lines.map((line) => (
                <dd key={line} className="whitespace-pre-wrap">
                  {line}
                </dd>
              ))}
              {item.links.map((link) => (
                <dd key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all font-medium text-ai-700 underline underline-offset-2"
                  >
                    {link.label}
                  </a>
                </dd>
              ))}
              {item.sources.map((source) => (
                <dd key={source.url} className="mt-0.5">
                  <SourceLink source={source} compact />
                </dd>
              ))}
            </div>
          ))}
        </dl>
      </div>
      {availability === "unavailable" ? null : (
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
      )}
    </section>
  );
}
