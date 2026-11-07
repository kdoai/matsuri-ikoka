import { AudioLines } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useActions, useApp, useT } from "../state/react";
import {
  allowRemoteVoice,
  canReadAloud,
  forgetRemoteVoice,
  sharedSpeaker,
  useReadAloudGuard,
  useVoiceOnDevice,
} from "./hooks";
import { speechLang } from "./speak";

/**
 * 読み上げのオン・オフ。読み上げの機能がないブラウザでは出さない（文字だけで使える）。
 * 使う声がこの端末の外のもの（または選べずブラウザに任せる）ときは、オンにするたびに先に説明する。
 * オンのまま言語を変えて端末の外の声になったときは、いったんオフにして（useReadAloudGuard）、
 * ここで一度だけ説明を出す。設定を閉じている間にオフになったときは、次に開いたときに出す
 */
export function ReadAloudToggle() {
  const t = useT();
  const actions = useActions();
  const locale = useApp((state) => state.ui.locale);
  const readAloud = useApp((state) => state.ui.readAloud);
  const notice = useApp((state) => state.ui.readAloudNotice);
  const lang = speechLang(locale);
  const onDevice = useVoiceOnDevice(lang);
  const [explaining, setExplaining] = useState(false);
  const title = useRef<HTMLParagraphElement>(null);
  useReadAloudGuard();

  // 自動でオフにしたわけを、一度だけ知らせる
  useEffect(() => {
    if (!notice) return;
    setExplaining(true);
    actions.setReadAloud(false);
  }, [notice, actions]);
  useEffect(() => {
    if (explaining) title.current?.focus();
  }, [explaining]);
  if (!canReadAloud()) return null;

  const turnOn = () => {
    setExplaining(false);
    if (!onDevice) allowRemoteVoice(lang);
    // 押したその場で出口を開けておく（聞こえる声は出さない）
    sharedSpeaker().prime();
    actions.setReadAloud(true);
  };

  return (
    <>
      <button
        type="button"
        className="flex min-h-11 items-center justify-center gap-2 rounded-xl border-2 border-ai-200 bg-white px-3 font-bold text-ai-800"
        aria-pressed={readAloud}
        title={t.voice.readAloudHint}
        data-testid="read-aloud-toggle"
        onClick={() => {
          if (readAloud) {
            forgetRemoteVoice();
            actions.setReadAloud(false);
            setExplaining(false);
          } else if (onDevice) turnOn();
          else setExplaining(true);
        }}
      >
        <AudioLines aria-hidden="true" className="size-4" />
        {readAloud ? t.voice.readAloudOn : t.voice.readAloudOff}
      </button>
      {explaining && !readAloud ? (
        <section
          className="rounded-xl border-2 border-line-strong bg-kinari-50 px-3 py-2 text-ink text-sm"
          aria-label={t.voice.readAloudRemoteTitle}
          data-testid="read-aloud-notice"
        >
          <p ref={title} tabIndex={-1} className="font-bold focus:outline-none">
            {t.voice.readAloudRemoteTitle}
          </p>
          <p className="mt-1 leading-relaxed">{t.voice.readAloudRemote}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="min-h-10 rounded-full border-2 border-wood-700/40 bg-yamabuki-400 px-4 font-bold text-ink"
              onClick={turnOn}
            >
              {t.voice.readAloudConfirm}
            </button>
            <button
              type="button"
              className="min-h-10 rounded-full border-2 border-line-strong bg-white px-4 font-bold text-ink"
              onClick={() => setExplaining(false)}
            >
              {t.voice.readAloudCancel}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
