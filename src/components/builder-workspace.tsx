"use client";

import { useEffect, useMemo, useState } from "react";
import type { AppBlueprint } from "@/lib/ai/schemas";

type ChatMessage = { role: "user" | "assistant"; text: string };

export function BuilderWorkspace({ projectId }: { projectId: string }) {
  const [prompt, setPrompt] = useState("");
  const [blueprint, setBlueprint] = useState<AppBlueprint | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: "Describe what you want to build. I’ll turn it into the application architecture first, then the code-generation pipeline can execute it." },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const initial = sessionStorage.getItem(`initial-prompt:${projectId}`);
    if (initial) {
      setPrompt(initial);
      sessionStorage.removeItem(`initial-prompt:${projectId}`);
    }
  }, [projectId]);

  const features = useMemo(() => blueprint?.features.slice(0, 3) ?? ["Dashboard", "Authentication", "Database"], [blueprint]);

  async function send() {
    const content = prompt.trim();
    if (content.length < 10 || busy) return;
    setBusy(true);
    setError("");
    setMessages((m) => [...m, { role: "user", text: content }]);
    setPrompt("");
    try {
      const res = await fetch("/api/ai/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, prompt: content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "The AI plan failed");
      setBlueprint(data.blueprint);
      setMessages((m) => [...m, { role: "assistant", text: `Architecture ready: ${data.blueprint.summary}` }]);
    } catch (e) {
      const message = e instanceof Error ? e.message : "The AI plan failed";
      setError(message);
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">LYMTLESS AI BUILDER</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge">{blueprint ? "PLANNED" : "DRAFT"}</span>
          <button className="secondary-btn">GitHub</button>
          <button className="primary-btn">Publish</button>
        </div>
      </header>
      <div className="builder">
        <aside className="sidebar">
          <div className="side-title">BUILD</div>
          {['Preview','Pages','Components','Database','Authentication','Storage','Functions','Integrations'].map((x, i) => <div key={x} className={`side-item ${i === 0 ? 'active' : ''}`}>{x}</div>)}
          <div className="side-title">DEVELOPER</div>
          {['Code','Console','Logs','Versions','Deployments','Settings'].map((x) => <div key={x} className="side-item">{x}</div>)}
        </aside>
        <section className="preview-wrap">
          <div className="preview-toolbar"><span className="status">Live Preview</span><span className="badge">Desktop</span></div>
          <div className="preview-canvas">
            <div className="browser">
              <div className="browser-top"><span className="dot"/><span className="dot"/><span className="dot"/></div>
              <div className="demo-app">
                <div style={{ color: '#506078', fontSize: 12, fontWeight: 800, letterSpacing: '.12em' }}>{blueprint?.appType?.toUpperCase() || 'GENERATED APP'}</div>
                <h2>{blueprint?.name || 'Your application will appear here'}</h2>
                <p>{blueprint?.summary || 'Describe the application in chat to create its architecture.'}</p>
                <div className="demo-grid">
                  {features.map((f) => <div key={f} className="demo-tile"><strong>{f}</strong><p>Generated module</p></div>)}
                </div>
                {blueprint && <div style={{ marginTop: 28 }}><strong>Pages</strong><p>{blueprint.pages.map(p => p.name).join(' • ')}</p></div>}
              </div>
            </div>
          </div>
        </section>
        <aside className="agent-panel">
          <div className="agent-header"><strong>AI Builder</strong><div className="status">Architecture agent</div></div>
          <div className="agent-log">
            {messages.map((m, i) => <div key={i} className={`message ${m.role === 'assistant' ? 'ai' : 'user'}`}>{m.text}</div>)}
            {busy && <div className="message ai">Analyzing application requirements…</div>}
          </div>
          <div className="composer">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Build a CRM, booking system, client portal…" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <div className="composer-row"><button className="primary-btn" disabled={busy || prompt.trim().length < 10} onClick={() => void send()}>{busy ? 'Working…' : 'Send'}</button></div>
            {error && <div className="status error" style={{ marginTop: 8 }}>{error}</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}
