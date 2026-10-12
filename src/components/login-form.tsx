"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const CONFIRM_REDIRECT = "https://lymtless-ai-builder-git.vercel.app/login?confirmed=1";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const router = useRouter();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const supabase = createClient();

    if (mode === "login") {
      const result = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (result.error) return setError(result.error.message);
      router.push("/");
      router.refresh();
      return;
    }

    const result = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: CONFIRM_REDIRECT },
    });
    setBusy(false);
    if (result.error) return setError(result.error.message);

    if (result.data.session) {
      router.push("/");
      router.refresh();
      return;
    }

    setNotice("Confirmation email sent. Open the newest email from LYMTLESS and click Confirm Email.");
  }

  async function resendConfirmation() {
    if (!email) {
      setError("Enter your email address first.");
      return;
    }
    setResending(true);
    setError("");
    setNotice("");
    const supabase = createClient();
    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: CONFIRM_REDIRECT },
    });
    setResending(false);
    if (resendError) return setError(resendError.message);
    setNotice("A fresh confirmation email was sent. Use the newest link only.");
  }

  const showResend = mode === "login" && error.toLowerCase().includes("email not confirmed");

  return (
    <form className="site-auth-card" onSubmit={submit}>
      <div className="site-auth-card-head">
        <span className="site-auth-card-id"><i /> LYMTLESS / SECURE ACCESS</span>
        <span className="site-auth-card-state">ENCRYPTED SESSION</span>
      </div>

      <h2>{mode === "login" ? "Welcome back." : "Enter the studio."}</h2>
      <p className="site-auth-card-intro">
        {mode === "login"
          ? "Access your projects, versions, previews, and build history."
          : "Create your LYMTLESS workspace and start your first full-stack build."}
      </p>

      <div className="site-auth-mode" aria-label="Authentication mode">
        <button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); setNotice(""); }}>
          SIGN IN
        </button>
        <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setError(""); setNotice(""); }}>
          CREATE ACCOUNT
        </button>
      </div>

      <div className="site-auth-field">
        <label htmlFor="email">Email address</label>
        <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>

      <div className="site-auth-field">
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>

      {error && <p className="site-auth-error">{error}</p>}
      {notice && <p className="site-auth-notice">{notice}</p>}

      {showResend && (
        <button type="button" className="site-auth-resend" onClick={resendConfirmation} disabled={resending}>
          {resending ? "SENDING…" : "RESEND CONFIRMATION EMAIL ↗"}
        </button>
      )}

      <button className="site-auth-submit" disabled={busy}>
        {busy ? "AUTHENTICATING…" : mode === "login" ? "ENTER WORKSPACE ↗" : "CREATE WORKSPACE ↗"}
      </button>

      <button type="button" className="site-auth-switch" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); setNotice(""); }}>
        {mode === "login" ? "New to LYMTLESS? Create an account" : "Already have an account? Sign in"}
      </button>

      <div className="site-auth-legal">
        Secure access to your LYMTLESS projects, generated source, application versions, and deployment workspace.
      </div>
    </form>
  );
}
