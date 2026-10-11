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
    <form className="card auth-card" onSubmit={submit}>
      <div className="eyebrow">LYMTLESS AI BUILDER</div>
      <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
      <div className="field"><label>Email</label><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <div className="field"><label>Password</label><input type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      {error && <p className="error">{error}</p>}
      <button className="primary-btn" style={{ width: "100%" }} disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
      <button type="button" onClick={() => setMode(mode === "login" ? "signup" : "login")} style={{ width: "100%", marginTop: 12, border: 0, color: "#aebbd1", background: "transparent" }}>
        {mode === "login" ? "Need an account? Create one" : "Already have an account? Sign in"}
      </button>
    </form>
  );
}
