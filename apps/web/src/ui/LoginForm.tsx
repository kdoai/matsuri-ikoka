import { LogIn } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { type AccountClient, LoginError, type LoginFailure } from "../account/client";
import type { Locale } from "../state/types";
import { buttonPrimary, buttonQuiet, buttonSecondary } from "./common";

// ログインの窓の中身（docs/spec/account.md）。Google と、メールアドレスとパスワード。
// 失敗の文は、そのメールアドレスが登録されているかどうかが分からないように書く。

/** パスワードの長さの下限 */
export const MIN_PASSWORD_LENGTH = 8;

type Mode = "signIn" | "signUp" | "reset";

export const LOGIN_MESSAGES = {
  ja: {
    lead: "旅を残して、あとで開くにはログインします。相談はログインしなくても続けられます。",
    google: "Google でログイン",
    or: "または",
    email: "メールアドレス",
    password: "パスワード",
    passwordHint: `${MIN_PASSWORD_LENGTH}文字以上`,
    signIn: "ログイン",
    signUp: "登録する",
    reset: "再設定のメールを送る",
    toSignIn: "ログインする",
    toSignUp: "はじめての方は登録",
    toReset: "パスワードを忘れたとき",
    resetSent:
      "入力したメールアドレスが登録されていれば、再設定のメールを送りました。届かないときは、迷惑メールも確かめてください。",
    failures: {
      credentials: "メールアドレスかパスワードが違います。",
      sign_up_refused:
        "このメールアドレスでは登録できませんでした。登録したことがあれば、ログインするか、パスワードを再設定してください。",
      weak_password: `パスワードは${MIN_PASSWORD_LENGTH}文字以上で、推測されにくいものにしてください。`,
      invalid_email: "メールアドレスの形を確かめてください。",
      too_many: "試した回数が多すぎます。しばらく待ってから、もう一度お試しください。",
      popup_blocked:
        "ログインの窓を開けませんでした。ブラウザのポップアップの設定をご確認ください。",
      other_method:
        "このメールアドレスは別の方法で登録されています。その方法でログインしてください。",
      trial: "お試し用のアカウントでは、この操作はできません。",
      account_remains:
        "旅は消しましたが、ログインの記録を消せませんでした。少し待ってから、もう一度お試しください。",
      failed: "うまくいきませんでした。少し待ってから、もう一度お試しください。",
    } satisfies Record<Exclude<LoginFailure, "cancelled">, string>,
  },
  en: {
    lead: "Sign in to keep a trip and open it later. You can keep chatting without signing in.",
    google: "Sign in with Google",
    or: "or",
    email: "Email",
    password: "Password",
    passwordHint: `At least ${MIN_PASSWORD_LENGTH} characters`,
    signIn: "Sign in",
    signUp: "Create account",
    reset: "Send reset email",
    toSignIn: "Sign in",
    toSignUp: "New here? Create an account",
    toReset: "Forgot your password?",
    resetSent:
      "If that address is registered, we sent a reset email. If it doesn't arrive, please check your spam folder.",
    failures: {
      credentials: "The email or password is incorrect.",
      sign_up_refused:
        "We couldn't create an account with this email. If you've registered before, sign in or reset your password.",
      weak_password: `Please use a hard-to-guess password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      invalid_email: "Please check the email address.",
      too_many: "Too many attempts. Please wait a while and try again.",
      popup_blocked: "We couldn't open the sign-in window. Please check your popup settings.",
      other_method:
        "This email is registered with another method. Please sign in with that method.",
      trial: "This action isn't available on the trial account.",
      account_remains:
        "Your trips were deleted, but we couldn't delete your sign-in record. Please try again in a moment.",
      failed: "Something went wrong. Please try again in a moment.",
    } satisfies Record<Exclude<LoginFailure, "cancelled">, string>,
  },
} satisfies Record<Locale, unknown>;

/** 失敗を、画面に出す文にする。やめただけなら null */
export function loginFailureText(locale: Locale, error: unknown): string | null {
  const failure = error instanceof LoginError ? error.failure : "failed";
  return failure === "cancelled" ? null : LOGIN_MESSAGES[locale].failures[failure];
}

export const inputClass =
  "mt-1 min-h-11 w-full rounded-xl border-2 border-wood-400 bg-white px-3 py-2 text-base text-ink focus:border-ai-600 focus:outline-none";

export function LoginForm({ client, locale }: { client: AccountClient; locale: Locale }) {
  const m = LOGIN_MESSAGES[locale];
  const id = useId();
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (task: () => Promise<void>) => {
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
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (mode === "signIn") await client.signInWithPassword(email.trim(), password);
      if (mode === "signUp") await client.signUpWithPassword(email.trim(), password);
      if (mode === "reset") {
        await client.sendPasswordReset(email.trim(), locale);
        setNotice(m.resetSent);
      }
    });
  };

  const tooShort = mode === "signUp" && password.length < MIN_PASSWORD_LENGTH;
  const incomplete = email.trim() === "" || (mode !== "reset" && password === "") || tooShort;

  return (
    <div className="grid gap-3">
      <p className="text-sm leading-relaxed">{m.lead}</p>
      <button
        type="button"
        className={buttonPrimary}
        disabled={busy}
        onClick={() => void run(() => client.signInWithGoogle())}
      >
        <LogIn className="size-4" />
        {m.google}
      </button>
      <p className="text-center text-ink-soft text-xs">{m.or}</p>
      <form className="grid gap-2" onSubmit={submit}>
        <div>
          <label htmlFor={`${id}-email`} className="block font-bold text-sm">
            {m.email}
          </label>
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
          />
        </div>
        {mode === "reset" ? null : (
          <div>
            <label htmlFor={`${id}-password`} className="block font-bold text-sm">
              {m.password}
              {mode === "signUp" ? (
                <span className="ml-2 font-normal text-ink-soft text-xs">{m.passwordHint}</span>
              ) : null}
            </label>
            <input
              id={`${id}-password`}
              type="password"
              autoComplete={mode === "signUp" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </div>
        )}
        <button type="submit" className={buttonSecondary} disabled={busy || incomplete}>
          {mode === "signIn" ? m.signIn : mode === "signUp" ? m.signUp : m.reset}
        </button>
      </form>
      <div className="flex flex-wrap justify-center gap-1">
        {mode === "signIn" ? null : (
          <button type="button" className={buttonQuiet} onClick={() => switchTo("signIn")}>
            {m.toSignIn}
          </button>
        )}
        {mode === "signUp" ? null : (
          <button type="button" className={buttonQuiet} onClick={() => switchTo("signUp")}>
            {m.toSignUp}
          </button>
        )}
        {mode === "reset" ? null : (
          <button type="button" className={buttonQuiet} onClick={() => switchTo("reset")}>
            {m.toReset}
          </button>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="text-shu-700 text-sm">
          {error}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </div>
  );
}
