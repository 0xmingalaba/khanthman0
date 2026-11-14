"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiRequestError, api } from "@/src/lib/api-client";
import type { Dictionary } from "@/src/i18n/dictionary";
import type { Locale } from "@/src/lib/locale";
import { SiteHeader } from "@/src/components/SiteHeader";
import { useApp } from "@/src/components/AppProvider";

type Props = { locale: Locale; t: Dictionary; mode: "login" | "signup" };

export function AuthView({ locale, t, mode }: Props) {
  const router = useRouter();
  const { user, wallet, signOut, refresh } = useApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A signed-in user has no reason to see the credential form.
  useEffect(() => {
    if (user) router.replace(`/${locale}/portfolio`);
  }, [user, router, locale]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (mode === "signup") {
        await api.register({ email, password, displayName, locale });
      } else {
        await api.login({ email, password });
      }
      await refresh();
      router.push(`/${locale}/portfolio`);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        if (caught.api.code === "rate_limited") setError(t.auth.errorRateLimited);
        else if (caught.api.code === "unauthenticated") setError(t.auth.errorInvalidCredentials);
        else if (caught.api.details) setError(Object.values(caught.api.details)[0] ?? t.auth.errorGeneric);
        else setError(caught.api.message);
      } else {
        setError(t.errors.network);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="app-shell">
      <div className="virtual-ribbon" role="note">
        <span className="pulse-dot" aria-hidden="true" /> {t.notice.virtual}
      </div>
      <SiteHeader
        locale={locale}
        t={t}
        user={user}
        availablePya={wallet?.availablePya ?? null}
        onLogout={() => void signOut()}
        showSearch={false}
      />

      <section className="auth-shell">
        <form className="auth-card" onSubmit={submit} noValidate>
          <div className="eyebrow">
            <span className="eyebrow-line" /> {t.brand.name}
          </div>
          <h1>{mode === "signup" ? t.auth.signupTitle : t.auth.loginTitle}</h1>
          <p className="auth-note">{t.auth.grantNotice}</p>

          {mode === "signup" && (
            <label className="field">
              <span>{t.auth.displayName}</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="nickname"
                required
                maxLength={60}
              />
            </label>
          )}

          <label className="field">
            <span>{t.auth.email}</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              maxLength={254}
            />
          </label>

          <label className="field">
            <span>{t.auth.password}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={mode === "signup" ? 10 : undefined}
              maxLength={200}
            />
            {mode === "signup" && <small>{t.auth.passwordHint}</small>}
          </label>

          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="preview-button" disabled={pending}>
            {pending ? t.actions.loading : mode === "signup" ? t.auth.submitSignup : t.auth.submitLogin}
          </button>

          <Link className="auth-switch" href={`/${locale}/${mode === "signup" ? "login" : "signup"}`}>
            {mode === "signup" ? t.auth.switchToLogin : t.auth.switchToSignup}
          </Link>
        </form>
      </section>
    </main>
  );
}
