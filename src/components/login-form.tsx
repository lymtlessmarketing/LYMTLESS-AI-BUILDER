"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const supabase = createClient();
    const result = mode === "login"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (result.error) return setError(result.error.message);
    router.push("/");
    router.refresh();
  }

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
        <button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); }}>
          SIGN IN
        </button>
        <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setError(""); }}>
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

      <button className="site-auth-submit" disabled={busy}>
        {busy ? "AUTHENTICATING…" : mode === "login" ? "ENTER WORKSPACE ↗" : "CREATE WORKSPACE ↗"}
      </button>

      <button type="button" className="site-auth-switch" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>
        {mode === "login" ? "New to LYMTLESS? Create an account" : "Already have an account? Sign in"}
      </button>

      <div className="site-auth-legal">
        Secure access to your LYMTLESS projects, generated source, application versions, and deployment workspace.
      </div>
    </form>
  );
}
