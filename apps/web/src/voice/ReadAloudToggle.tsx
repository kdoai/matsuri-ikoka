import { AudioLines } from "lucide-react";
import { useApp, useT } from "../state/react";
import { canReadAloud, sharedSpeaker, useVoicePrefs } from "./hooks";
import { voicePrefs } from "./prefs";
import { speechLang } from "./speak";

/** 読み上げのオン・オフ。読み上げの機能がないブラウザでは出さない（文字だけで使える） */
export function ReadAloudToggle() {
  const t = useT();
  const locale = useApp((state) => state.ui.locale);
  const { readAloud } = useVoicePrefs();
  if (!canReadAloud()) return null;
  return (
    <button
      type="button"
      className="flex min-h-11 items-center justify-center gap-2 rounded-xl border-2 border-ai-200 bg-white px-3 font-bold text-ai-800"
      aria-pressed={readAloud}
      title={t.voice.readAloudHint}
      data-testid="read-aloud-toggle"
      onClick={() => {
        const on = !readAloud;
        // 押したその場で一度読む（押してからでないと声を出さないブラウザがある）。会話の窓の文に置き換わる
        if (on) sharedSpeaker().say(t.voice.readAloudOn, speechLang(locale));
        voicePrefs().setReadAloud(on);
      }}
    >
      <AudioLines aria-hidden="true" className="size-4" />
      {readAloud ? t.voice.readAloudOn : t.voice.readAloudOff}
    </button>
  );
}
