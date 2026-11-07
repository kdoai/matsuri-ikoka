import { BookOpen, Store, Tent } from "lucide-react";
import {
  Component,
  type CSSProperties,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAccountUser } from "../account/useAccountUser";
import { prefetchModels, STREET_SCENE_MODELS } from "../scenes/modelFiles";
import { unreadNotices } from "../state/guide";
import { playStore, usePlay } from "../state/play";
import { useActions, useApp, useAppStore, useT } from "../state/react";
import { selectStreetSceneProps } from "../state/scene";
import { shioriReady } from "../state/selectors";
import { AccountMenu } from "./AccountMenu";
import { openAccountMenu } from "./accountMenuEntry";
import { focusGuideDialogue, GuideDialogue } from "./GuideDialogue";
import { KeyCap, Logo, ModeBadge, useHudKeys } from "./Hud";
import { useMediaQuery } from "./hooks";
import { PasscodeDialog } from "./Passcode";
import { PlayPrompt, PlayStatus } from "./Play";
import { Portrait } from "./Portraits";
import { SceneLoading } from "./SceneLoading";
import { LanguageButton, useFrameInsets } from "./Shop";
import { GuideBoard, GuideStallFront } from "./StreetStalls";
import { StreetScene, useScene3d } from "./scene3d";

// しおりのあとの画面。店の外の縁日の通りで、ガイドと話す。旅のことは、すべてガイド1人に尋ねればよい。
// 3D が主役で、会話の窓とガイドの屋台の窓を重ねる。動きを減らす設定や 3D が使えないときは、ガイドの屋台の正面を主にする。
// どちらでも、知らせ・組み直しの案・相談がすべて使える。店へ戻る口はいつも出す。

class StreetBoundary extends Component<{ onError: () => void; children: ReactNode }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.warn("[scene] 3D の通りを出せなかったので、ガイドの屋台の正面にします", error);
    this.props.onError();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

const roundButton =
  "relative grid size-10 shrink-0 place-items-center rounded-full border-2 border-kinari-50/85 bg-ai-900/70 text-kinari-50 shadow-lg backdrop-blur-sm transition hover:bg-ai-700 sm:size-11";

/** ログインなしの旅は相談の間しか続かない。残すとあとで開けることを、ログインしていない人に伝える */
function GuestNote() {
  const t = useT();
  const { enabled: loginOffered, user } = useAccountUser();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || user !== null) return null;
  return (
    <aside
      data-testid="guest-note"
      className="washi w-full max-w-sm rounded-2xl border border-line-strong px-3 py-2 text-ink text-sm shadow-soft"
    >
      <p>{t.street.guestNote}</p>
      {loginOffered ? (
        <p className="mt-0.5">
          {t.street.guestKeep}{" "}
          <button
            type="button"
            className="font-bold text-ai-700 underline underline-offset-2"
            // ログインの処理は今の入口にまかせる（入口を開くだけ）
            onClick={openAccountMenu}
          >
            {t.street.guestLogin}
          </button>
        </p>
      ) : null}
      <button
        type="button"
        className="mt-1 font-bold text-ink-soft text-xs underline underline-offset-2"
        onClick={() => setDismissed(true)}
      >
        {t.street.dismiss}
      </button>
    </aside>
  );
}

/** 3D の通り。読み込むまでは読み込みの表示を出す */
function StreetStage({
  frame,
  onTalk,
  onFail,
}: {
  frame: ReturnType<typeof useFrameInsets>;
  onTalk: () => void;
  onFail: () => void;
}) {
  const actions = useActions();
  const t = useT();
  const props = useApp((state) => selectStreetSceneProps(state, frame));
  const covered = useApp((state) => state.guide.dialogueOpen || state.guide.openStall !== null);
  const nearGuide = usePlay((state) => state.near?.kind === "talk");
  const [ready, setReady] = useState(false);
  const onDoor = useCallback(() => void actions.returnToShop(), [actions]);
  // 描けなくなったら（読み込みの失敗も含む）、案内は歩かずに屋台を開く
  useEffect(() => () => actions.setStreetScene(false), [actions]);
  if (StreetScene === null) return null;
  return (
    <div className="absolute inset-0" data-testid="street-stage">
      <StreetBoundary onError={onFail}>
        <Suspense fallback={null}>
          <StreetScene
            {...props}
            onReady={() => {
              setReady(true);
              actions.setStreetScene(true);
            }}
            onTalk={onTalk}
            onStall={actions.openStall}
            onDoor={onDoor}
          />
        </Suspense>
        {ready ? (
          <>
            <PlayPrompt />
            {covered || nearGuide ? null : (
              <div aria-hidden="true" className="pointer-events-none absolute inset-0">
                <p
                  data-bubble="concierge"
                  className="absolute top-0 left-0 flex items-center gap-1 rounded-full border-2 border-yamabuki-400 bg-kinari-50 py-0.5 pr-2.5 pl-1 font-bold text-ink text-xs shadow-soft"
                >
                  <span className="grid size-5 place-items-center rounded-full bg-yamabuki-400 font-black">
                    ！
                  </span>
                  {t.street.marker}
                </p>
              </div>
            )}
          </>
        ) : (
          <SceneLoading
            models={STREET_SCENE_MODELS}
            className="-translate-x-1/2 absolute top-1/3 left-1/2"
          />
        )}
      </StreetBoundary>
    </div>
  );
}

export function Street() {
  const t = useT();
  const actions = useActions();
  const store = useAppStore();
  const wants3d = useScene3d() && StreetScene !== null;
  const [failed, setFailed] = useState(false);
  const use3d = wants3d && !failed;
  const wide = useMediaQuery("(min-width: 1024px)");
  const guideOpen = useApp((state) => state.guide.dialogueOpen);
  const openStall = useApp((state) => state.guide.openStall);
  const listOpen = useApp((state) => state.guide.listOpen);
  const phase = useApp((state) => state.guide.phase);
  const notices = useApp((state) => state.guide.notices);
  const ready = useApp(shioriReady);
  const unread = useMemo(() => unreadNotices({ notices }).length, [notices]);

  const topRef = useRef<HTMLDivElement>(null);
  const dialogueRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const beside = wide && (openStall !== null || listOpen);
  const frame = useFrameInsets(topRef, dialogueRef, panelRef, beside);

  useEffect(() => {
    if (use3d) prefetchModels(STREET_SCENE_MODELS).catch(() => undefined);
  }, [use3d]);

  const talk = useCallback(() => {
    actions.setGuideDialogue(true);
    window.requestAnimationFrame(focusGuideDialogue);
  }, [actions]);

  useHudKeys({
    // 3D の旅人がいれば、近くのものを使う（近くになければ、ガイドに話しかける）
    talk: () => {
      const play = playStore.getState();
      if (play.active) play.requestInteract();
      else talk();
    },
    details: () => actions.setStallList(!store.getState().guide.listOpen),
    map: () => undefined,
    menu: () => undefined,
  });

  const closeList = useCallback(() => actions.setStallList(false), [actions]);

  return (
    <div
      className={`relative h-dvh w-full bg-wood-900 text-ink ${use3d ? "overflow-hidden" : "overflow-y-auto"}`}
      data-testid="street"
      data-mode={use3d ? "3d" : "2d"}
    >
      {use3d ? <StreetStage frame={frame} onTalk={talk} onFail={() => setFailed(true)} /> : null}

      {/* 上の段：ロゴと、ガイドの屋台・しおり・店へ戻る口 */}
      <div
        ref={topRef}
        className="no-print pointer-events-none absolute inset-x-0 top-0 z-40 grid grid-cols-[1fr_auto] items-start gap-2 p-2 sm:p-3 [&>*]:pointer-events-auto"
      >
        <div className="flex flex-col items-start gap-1.5 justify-self-start">
          <Logo />
          <p className="hud-chip w-fit rounded-full px-3 py-1 font-bold text-sm leading-tight">
            {phase === null
              ? t.street.title
              : t.street.dotted([t.street.title, t.street.phase[phase]])}
          </p>
          <ModeBadge />
        </div>
        <div className="flex items-center gap-1.5 justify-self-end sm:gap-2">
          <AccountMenu />
          {use3d ? (
            <button
              type="button"
              className={roundButton}
              aria-label={t.street.list}
              title={t.street.list}
              aria-expanded={listOpen}
              data-testid="stall-list-button"
              onClick={() => actions.setStallList(!listOpen)}
            >
              <Tent aria-hidden="true" className="size-5" />
              {unread > 0 ? (
                <span className="-top-1 -right-1 absolute grid min-w-5 place-items-center rounded-full bg-shu-600 px-1 font-bold text-white text-xs">
                  {unread}
                </span>
              ) : null}
            </button>
          ) : null}
          {ready ? (
            <button
              type="button"
              className={roundButton}
              aria-label={t.itinerary.openShiori}
              title={t.itinerary.openShiori}
              onClick={actions.openShiori}
            >
              <BookOpen aria-hidden="true" className="size-5" />
            </button>
          ) : null}
          <button
            type="button"
            className={roundButton}
            aria-label={t.street.backToShop}
            title={t.street.backToShop}
            data-testid="back-to-shop"
            onClick={() => void actions.returnToShop()}
          >
            <Store aria-hidden="true" className="size-5" />
          </button>
          <LanguageButton className="min-h-10 rounded-lg border border-kinari-300/60 bg-ai-900/70 px-2.5 py-1 font-semibold text-kinari-50 text-sm hover:bg-ai-700" />
        </div>
      </div>

      {/* 3D に出ることを、読み上げにも伝える */}
      <div className="sr-only">
        <PlayStatus hidden />
        <p role="status" data-testid="street-lit">
          {unread > 0 ? t.street.unreadNotices(unread) : ""}
        </p>
      </div>

      {/* 2D を主にするときは、ガイドの屋台の正面がそのまま通りになる */}
      {use3d ? null : (
        <main
          className="mx-auto w-full max-w-2xl px-3 pb-44"
          style={{ paddingTop: frame.top + 8 }}
          data-testid="street-board"
        >
          <GuideStallFront onTalk={talk} />
          <div className="mt-3">
            <GuestNote />
          </div>
        </main>
      )}

      {/* ログインなしの旅の案内（2D ではガイドの屋台の下に出す） */}
      {use3d && !guideOpen && openStall === null && !listOpen ? (
        <div
          className="absolute left-2 z-20 w-[min(22rem,calc(100vw-1rem))] sm:left-3"
          style={{ top: frame.top + 8 }}
        >
          <GuestNote />
        </div>
      ) : null}

      {/* ガイドの屋台の窓。3D の屋台に触れたときも、上の段から開いたときも、同じ1つの窓を出す */}
      {openStall === null && !listOpen ? null : (
        <div
          ref={panelRef}
          className="fixed inset-x-2 bottom-2 z-30 lg:right-3 lg:bottom-3 lg:left-auto lg:w-[min(34rem,42vw)]"
          style={{ top: frame.top + 6 }}
          data-testid="stall-list-panel"
        >
          <GuideBoard
            stall={openStall}
            onClose={openStall === null ? closeList : actions.closeStall}
          />
        </div>
      )}

      {/* ガイドに話しかける */}
      {guideOpen || openStall !== null || listOpen ? null : (
        <div className="fixed inset-x-2 bottom-3 z-20 sm:bottom-4" data-testid="guide-bar">
          <div className="mx-auto w-fit max-w-full">
            <button
              type="button"
              onClick={talk}
              aria-label={t.street.talk}
              className="hud-chip flex items-center gap-2 rounded-full py-1 pr-4 pl-1 font-bold text-sm transition hover:bg-ink/80"
            >
              <Portrait speaker="concierge" className="size-8 border" />
              <KeyCap small>E</KeyCap>
              <span aria-hidden="true">{t.street.talk}</span>
            </button>
          </div>
        </div>
      )}

      <div
        ref={dialogueRef}
        hidden={!guideOpen}
        style={{ "--frame-top": `${frame.top}px` } as CSSProperties}
        className="fixed inset-x-2 bottom-2 z-30 sm:inset-x-3 sm:bottom-3 lg:inset-x-0 lg:mx-auto lg:w-[min(50rem,calc(100vw-4rem))]"
      >
        {guideOpen ? <GuideDialogue /> : null}
      </div>

      <PasscodeDialog />
    </div>
  );
}
