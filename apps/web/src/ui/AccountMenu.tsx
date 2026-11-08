import type { TripSummary } from "@matsuri-ikoka/schema";
import { BookOpen, MessageCircle, Trash2, UserRound } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoginError } from "../account/client";
import { useAccountClient } from "../account/context";
import { useAccountUser } from "../account/useAccountUser";
import { formatDate } from "../i18n";
import { useActions, useApp } from "../state/react";
import type { Locale } from "../state/types";
import { buttonPrimary, buttonQuiet, buttonSecondary } from "./common";
import { inputClass, LoginForm, loginFailureText } from "./LoginForm";

// ログインのボタンと、自分の旅の一覧（docs/spec/account.md）。
// 相談はログインなしで始められる。旅を残す・あとで開く・消すのは、ログインしてから。
// ログインを用意していないとき（Firebase の設定のないサーバー）は何も出さない。

const MESSAGES = {
  ja: {
    button: "ログインと自分の旅",
    title: "自分の旅",
    signedIn: (name: string | null) => (name ? `${name} さんでログイン中` : "ログイン中"),
    save: "この旅を残す",
    saved: "残しました",
    empty: "まだ残した旅はありません。",
    open: "しおりを開く",
    resume: "店で続ける",
    resumeFailed: "この旅を店で開けませんでした。少し待ってから、もう一度お試しください。",
    delete: "消す",
    confirmDelete: (title: string) =>
      `「${title}」を消します。共有したしおりの URL も開けなくなります。`,
    logout: "ログアウト",
    trialNote:
      "お試し用のアカウントです。残した旅は、同じアカウントを使うほかの人にも見え、初期の状態に戻すと消えます。",
    changePassword: "パスワードを変える",
    changePasswordSent:
      "パスワードを変えるメールを送りました。メールの案内に沿って進めてください。",
    confirmPassword: "確かめのため、パスワードを入れてください",
    confirmGoogle: "確かめのため、Google のログインの窓が開きます。",
    confirmDeleteAllButton: "すべて消す",
    cancel: "やめる",
    deleteAll: "旅とログインの記録をすべて消す",
    confirmDeleteAll:
      "残した旅と共有したしおり、このアプリのログインの記録をすべて消して、ログアウトします。元に戻せません。",
    keepNote:
      "残した旅は、消すまで残ります。「店で続ける」から続きを相談できます。しおりの共有の URL は、作ってから30日と、旅の最終日の3日後の遅い方まで開けます。",
    close: "閉じる",
    untitled: "名前のない旅",
  },
  en: {
    button: "Sign in and my trips",
    title: "My trips",
    signedIn: (name: string | null) => (name ? `Signed in as ${name}` : "Signed in"),
    save: "Keep this trip",
    saved: "Kept",
    empty: "No trips kept yet.",
    open: "Open guide",
    resume: "Continue in the shop",
    resumeFailed: "Couldn't open this trip in the shop. Please try again in a moment.",
    delete: "Delete",
    confirmDelete: (title: string) =>
      `Delete "${title}"? Shared guide links will stop working too.`,
    logout: "Sign out",
    trialNote:
      "This is the trial account. Others using it can see kept trips, and they're removed when the account is reset.",
    changePassword: "Change password",
    changePasswordSent: "We sent you an email to change your password. Please follow its steps.",
    confirmPassword: "Please enter your password to confirm",
    confirmGoogle: "A Google sign-in window will open to confirm it's you.",
    confirmDeleteAllButton: "Delete everything",
    cancel: "Cancel",
    deleteAll: "Delete all trips and my sign-in record",
    confirmDeleteAll:
      "This deletes your kept trips, shared guides, and this app's sign-in record, then signs you out. This cannot be undone.",
    keepNote:
      "Kept trips stay until you delete them. Use Continue in the shop to keep planning. Shared guide links open for 30 days or until 3 days after the trip, whichever is later.",
    close: "Close",
    untitled: "Untitled trip",
  },
} satisfies Record<Locale, unknown>;

const roundIcon =
  "relative grid size-10 shrink-0 place-items-center sm:size-11 rounded-full border-2 border-kinari-50/85 bg-ai-900/70 text-kinari-50 shadow-lg backdrop-blur-sm transition hover:bg-ai-700";
const card =
  "rounded-2xl border-2 border-wood-700/50 bg-kinari-50/95 shadow-[0_8px_24px_rgb(0_0_0/0.3)] backdrop-blur-sm";

/** ポップアップを止められないよう、押したときに空の窓を開いておき、あとから行き先を入れる */
function openLater(): (path: string) => void {
  const opened = window.open("about:blank", "_blank");
  if (opened !== null) opened.opener = null;
  return (path) => {
    if (opened === null) window.location.assign(path);
    else opened.location.href = path;
  };
}

export function AccountMenu() {
  const client = useAccountClient();
  const { restart, resumeSavedTrip } = useActions();
  const locale = useApp((state) => state.ui.locale);
  const sessionId = useApp((state) => state.session.id);
  const itineraryId = useApp((state) => state.itinerary.current?.id ?? null);
  const m = MESSAGES[locale];
  const { enabled, user } = useAccountUser();
  const userId = user?.id ?? null;
  const [open, setOpen] = useState(false);
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [password, setPassword] = useState("");
  const passwordId = useId();
  const ref = useRef<HTMLDivElement>(null);

  // 利用者が変わったら、前の人の一覧・入力・文を残さない
  // biome-ignore lint/correctness/useExhaustiveDependencies: userId は片付けのきっかけとして見る
  useEffect(() => {
    setTrips(null);
    setConfirmingDelete(false);
    setPassword("");
    setNotice(null);
    setError(null);
  }, [userId]);

  const run = useCallback(
    async (task: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await task();
      } catch (caught) {
        setError(loginFailureText(locale, caught));
      } finally {
        setBusy(false);
      }
    },
    [locale],
  );

  const refresh = useCallback(async () => {
    if (client !== null) setTrips(await client.listTrips());
  }, [client]);

  // 開いたときに一覧を読む
  useEffect(() => {
    if (open && user !== null && trips === null) void run(refresh);
  }, [open, user, trips, run, refresh]);

  // 外を押すか Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (client === null || !enabled) return null;
  const savedHere = itineraryId !== null && trips?.some((t) => t.itineraryId === itineraryId);

  return (
    <div ref={ref} className="relative" data-testid="account-menu">
      <button
        type="button"
        className={roundIcon}
        aria-label={m.button}
        title={m.button}
        aria-expanded={open}
        aria-controls="account-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <UserRound className="size-5" />
        {user !== null ? (
          <span className="absolute right-0.5 bottom-0.5 size-3 rounded-full bg-yamabuki-400 ring-2 ring-kinari-50" />
        ) : null}
      </button>
      {open ? (
        <div
          id="account-panel"
          role="dialog"
          aria-label={m.title}
          // ボタンは右の列の途中にあるので、ボタンに合わせず画面に合わせて置く（狭い画面でも左にはみ出さない）
          className={`${card} fixed top-14 right-3 z-50 max-h-[calc(100dvh-4.5rem)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto p-4 text-ink sm:top-16 sm:max-h-[calc(100dvh-5rem)]`}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-bold">{m.title}</p>
            <button
              type="button"
              className="rounded-full px-2 py-0.5 text-ink-soft text-sm hover:bg-kinari-200"
              onClick={() => setOpen(false)}
            >
              {m.close}
            </button>
          </div>

          {user === null ? (
            <LoginForm client={client} locale={locale} />
          ) : (
            <div className="grid gap-3">
              <p className="text-ink-soft text-sm">{m.signedIn(user.name)}</p>
              {user.trial ? <p className="text-sm leading-relaxed">{m.trialNote}</p> : null}
              {sessionId !== null && itineraryId !== null ? (
                <button
                  type="button"
                  className={buttonPrimary}
                  disabled={busy || savedHere}
                  onClick={() =>
                    void run(async () => {
                      await client.saveTrip(sessionId);
                      await refresh();
                    })
                  }
                >
                  {savedHere ? m.saved : m.save}
                </button>
              ) : null}

              {trips !== null && trips.length === 0 ? <p className="text-sm">{m.empty}</p> : null}
              {trips !== null && trips.length > 0 ? (
                <ul className="grid max-h-64 gap-2 overflow-y-auto" aria-label={m.title}>
                  {trips.map((trip) => (
                    <li
                      key={trip.itineraryId}
                      className="rounded-xl border border-wood-300 bg-white px-3 py-2"
                    >
                      <p className="font-bold text-sm">{trip.title || m.untitled}</p>
                      {trip.date !== null ? (
                        <p className="text-ink-soft text-xs">{formatDate(trip.date, locale)}</p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-1">
                        <button
                          type="button"
                          className={buttonQuiet}
                          disabled={busy}
                          onClick={() => {
                            const go = openLater();
                            void run(async () => go(await client.shareTrip(trip.itineraryId)));
                          }}
                        >
                          <BookOpen className="size-4" />
                          {m.open}
                        </button>
                        <button
                          type="button"
                          className={buttonQuiet}
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              // 確定する前の旅も、店に戻して続きを相談できる
                              if (await resumeSavedTrip(trip.itineraryId)) setOpen(false);
                              else setError(m.resumeFailed);
                            })
                          }
                        >
                          <MessageCircle className="size-4" />
                          {m.resume}
                        </button>
                        <button
                          type="button"
                          className={`${buttonQuiet} text-shu-700`}
                          disabled={busy}
                          onClick={() => {
                            if (!window.confirm(m.confirmDelete(trip.title || m.untitled))) return;
                            void run(async () => {
                              await client.deleteTrip(trip.itineraryId);
                              // 消した旅を画面に残さない。一覧を読めなくても残さないよう、先に行う
                              if (trip.itineraryId === itineraryId) await restart();
                              await refresh();
                            });
                          }}
                        >
                          <Trash2 className="size-4" />
                          {m.delete}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-ink-soft text-xs leading-relaxed">{m.keepNote}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonSecondary}
                  disabled={busy}
                  onClick={() => void run(() => client.signOut())}
                >
                  {m.logout}
                </button>
                {user.usesPassword && !user.trial ? (
                  <button
                    type="button"
                    className={buttonQuiet}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await client.changePassword(locale);
                        setNotice(m.changePasswordSent);
                      })
                    }
                  >
                    {m.changePassword}
                  </button>
                ) : null}
                {user.trial ? null : (
                  <button
                    type="button"
                    className={`${buttonQuiet} text-shu-700`}
                    disabled={busy}
                    aria-expanded={confirmingDelete}
                    onClick={() => setConfirmingDelete((value) => !value)}
                  >
                    {m.deleteAll}
                  </button>
                )}
              </div>
              {confirmingDelete && !user.trial ? (
                <form
                  className="grid gap-2 rounded-xl border border-shu-600 bg-white p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    // Google の確かめ直しの窓は、この押した操作の中で開く
                    void run(async () => {
                      try {
                        await client.deleteEverything(user.usesPassword ? password : undefined);
                      } catch (caught) {
                        // 旅はもう消えているので、前の旅程を画面に残さない。もう一度消せるようにする
                        if (caught instanceof LoginError && caught.failure === "account_remains") {
                          setTrips(null);
                          await restart();
                        }
                        throw caught;
                      }
                    });
                  }}
                >
                  <p className="text-sm leading-relaxed">{m.confirmDeleteAll}</p>
                  {user.usesPassword ? (
                    <div>
                      <label htmlFor={passwordId} className="block font-bold text-sm">
                        {m.confirmPassword}
                      </label>
                      <input
                        id={passwordId}
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        className={inputClass}
                      />
                    </div>
                  ) : (
                    <p className="text-ink-soft text-xs">{m.confirmGoogle}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="submit"
                      className={buttonSecondary}
                      disabled={busy || (user.usesPassword && password === "")}
                    >
                      {m.confirmDeleteAllButton}
                    </button>
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => {
                        setConfirmingDelete(false);
                        setPassword("");
                      }}
                    >
                      {m.cancel}
                    </button>
                  </div>
                </form>
              ) : null}
              {notice === null ? null : (
                <p role="status" className="text-sm">
                  {notice}
                </p>
              )}
            </div>
          )}
          {error === null ? null : (
            <p role="alert" className="mt-2 text-shu-700 text-sm">
              {error}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
