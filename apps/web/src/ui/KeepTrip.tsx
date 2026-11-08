import { useEffect, useState } from "react";
import { useAccountClient } from "../account/context";
import { useAccountUser } from "../account/useAccountUser";
import { useApp, useT } from "../state/react";
import { buttonSecondary } from "./common";
import { LoginForm } from "./LoginForm";

// しおりの画面の「この旅を残す」。残した旅は消すまで残り、「ログインと自分の旅」からあとで開ける。
// ログインしていなければ、その場でログインしてから残せる。ログインを用意していないときは何も出さない。

type KeepState = "idle" | "busy" | "kept" | "failed";

export function KeepTrip() {
  const t = useT();
  const client = useAccountClient();
  const { enabled, user } = useAccountUser();
  const locale = useApp((state) => state.ui.locale);
  const sessionId = useApp((state) => state.session.id);
  const itineraryId = useApp((state) => state.itinerary.current?.id ?? null);
  const userId = user?.id ?? null;
  const [keep, setKeep] = useState<KeepState>("idle");
  const [loggingIn, setLoggingIn] = useState(false);

  // 旅か利用者が変わったら、前の結果を残さない
  // biome-ignore lint/correctness/useExhaustiveDependencies: 旅と利用者は片付けのきっかけとして見る
  useEffect(() => {
    setKeep("idle");
    setLoggingIn(false);
  }, [itineraryId, userId]);

  if (client === null || !enabled || sessionId === null || itineraryId === null) return null;

  if (user === null) {
    return (
      <div className="relative">
        <button
          type="button"
          className={`${buttonSecondary} bg-kinari-50`}
          aria-expanded={loggingIn}
          onClick={() => setLoggingIn((value) => !value)}
        >
          {t.shiori.keepLogin}
        </button>
        {loggingIn ? (
          <div className="absolute top-full left-0 z-20 mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl bg-kinari-50 p-4 text-ink shadow-lg">
            <LoginForm client={client} locale={locale} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={`${buttonSecondary} bg-kinari-50`}
        disabled={keep === "busy" || keep === "kept"}
        data-testid="shiori-keep"
        onClick={() => {
          setKeep("busy");
          client.saveTrip(sessionId).then(
            () => setKeep("kept"),
            () => setKeep("failed"),
          );
        }}
      >
        {t.shiori.keep}
      </button>
      {keep === "kept" ? (
        <p role="status" className="text-kinari-50 text-sm">
          {t.shiori.kept}
        </p>
      ) : null}
      {keep === "failed" ? (
        <p role="alert" className="text-kinari-50 text-sm">
          {t.shiori.keepFailed}
        </p>
      ) : null}
    </div>
  );
}
