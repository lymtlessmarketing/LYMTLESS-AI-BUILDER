"use client";

import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const WORKSPACE_URL = "/workspace";
const PENDING_PROMPT_KEY = "pending-build-prompt";

function confirmationRedirect() {
  if (typeof window === "undefined") return "https://lymtless-ai-builder-git.vercel.app/login?confirmed=1";
  return `${window.location.origin}/login?confirmed=1`;
}

async function readPayload(response: Response) {
  const text = await response.text();
  if (!text) return {} as { error?: string; project?: { id: string } };
  try {
    return JSON.parse(text) as { error?: string; project?: { id: string } };
  } catch {
    return { error: `Request failed with HTTP ${response.status}.` };
  }
}

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);

  async function continueAfterAuth() {
    const pendingPrompt = sessionStorage.getItem(PENDING_PROMPT_KEY);
    if (!pendingPrompt) {
      window.location.assign(WORKSPACE_URL);
      return;
    }

    const projectRes = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Untitled App" }),
    });
    const projectData = await readPayload(projectRes);
    if (!projectRes.ok || !projectData.project?.id) {
      throw new Error(projectData.error || "Signed in, but the pending project could not be created.");
    }

    sessionStorage.removeItem(PENDING_PROMPT_KEY);
    sessionStorage.setItem(`initial-prompt:${projectData.project.id}`, pendingPrompt);
    window.location.assign(`/builder/${projectData.project.id}`);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError("");
    setNotice("");

    try {
      const supabase = createClient();

      if (mode === "login") {
        const result = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (result.error) throw result.error;
        if (!result.data.session) throw new Error("Sign-in succeeded but no session was created. Please try again.");
        await continueAfterAuth();
        return;
      }

      const result = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: confirmationRedirect() },
      });
      if (result.error) throw result.error;

      if (result.data.session) {
        await continueAfterAuth();
        return;
      }

      setNotice("Confirmation email sent. Open the newest email from LYMTLESS and click Confirm Email.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resendConfirmation() {
    if (!email.trim()) {
      setError("Enter your email address first.");
      return;
    }
    if (resending) return;

    setResending(true);
    setError("");
    setNotice("");
    try {
      const supabase = createClient();
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email: email.trim(),
        options: { emailRedirectTo: confirmationRedirect() },
      });
      if (resendError) throw resendError;
      setNotice("A fresh confirmation email was sent. Use the newest link only.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resend the confirmation email.");
    } finally {
      setResending(false);
    }
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
