import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useActions, useApp, useT } from "../state/react";
import { isSendablePasscode } from "../transport/server";
import { buttonPrimary } from "./common";

// 合言葉の入力。公開している URL で、接客サーバーが合言葉を求めたときだけ出す。
// 合言葉はメモリにだけ持ち、URL にも保存にも入れない。端末に残すと、同じ端末を使うほかの人も
// 入れてしまい、漏れたときに消す手立てもないため。そのため再読み込みや別のタブでは入れ直してもらい、
// そのことを欄の案内（passcode.where）で伝える。

export function PasscodeForm({ retry }: { retry: boolean }) {
  const t = useT();
  const actions = useActions();
  const rejected = useApp((state) => state.auth.rejected);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const messageId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const passcode = value.trim();
    // 合言葉はヘッダーで送るので、半角の英数字と記号だけを受け付ける
    if (!isSendablePasscode(passcode)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setValue("");
    void actions.submitPasscode(passcode);
  };

  return (
    <form onSubmit={submit} className="space-y-2 text-left" data-testid="passcode-form">
      <p id={messageId} className="text-ink text-sm">
        {invalid || rejected ? (
          <span className="block font-bold text-shu-700" role="alert">
            {invalid ? t.passcode.halfWidth : t.passcode.wrong}
          </span>
        ) : null}
        {retry ? t.passcode.again : t.passcode.lead}
        <span className="mt-1 block text-ink-soft text-xs leading-relaxed">{t.passcode.where}</span>
      </p>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor={inputId} className="block font-bold text-ink text-sm">
            {t.passcode.label}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-describedby={messageId}
            aria-invalid={invalid || rejected}
            className="mt-1 min-h-11 w-full rounded-xl border-2 border-wood-400 bg-white px-3 py-2 text-base text-ink focus:border-ai-600 focus:outline-none"
          />
        </div>
        <button type="submit" className={buttonPrimary} disabled={value.trim() === ""}>
          {retry ? t.passcode.submitRetry : t.passcode.submit}
        </button>
      </div>
    </form>
  );
}

/** 相談の途中で合言葉を聞き直すときの小さな窓 */
export function PasscodeDialog() {
  const t = useT();
  const needed = useApp((state) => state.auth.needed);
  if (!needed) {
    return null;
  }
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4"
      data-testid="passcode-dialog"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="passcode-dialog-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border-4 border-wood-800 bg-kinari-50 p-5 shadow-2xl"
      >
        <h2 id="passcode-dialog-title" className="mb-2 font-bold text-ink text-lg">
          {t.passcode.title}
        </h2>
        <PasscodeForm retry />
      </section>
    </div>
  );
}
