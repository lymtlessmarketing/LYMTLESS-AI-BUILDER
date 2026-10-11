"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppBlueprint } from "@/lib/ai/schemas";
import { GithubControls } from "@/components/github-controls";

type ChatMessage = { role: "user" | "assistant"; text: string };
type BuildStage = "idle" | "planning" | "generating" | "provisioning" | "configuring" | "building" | "ready" | "failed";
type GenerationResult = { version: { id: string; number: number; summary: string }; files: string[] };
type SandboxBuildResult = {
  buildRunId: string;
  sandboxName: string;
  versionId: string;
  previewUrl: string;
  repairAttempts: number;
  backendConnected: boolean;
  qa: { passed: boolean; findings: Array<{ severity: string; code: string; message: string; viewport?: string }> };
  visualQa: {
    passed: boolean;
    score: number | null;
    findings: Array<{ severity: string; viewport: string; category: string; issue: string; recommendation: string }>;
  };
  installLog: string;
  buildLog: string;
  qaLog: string;
  visualLog: string;
  previewLog: string;
};

export function BuilderWorkspace({ projectId }: { projectId: string }) {
  const [prompt, setPrompt] = useState("");
  const [blueprint, setBlueprint] = useState<AppBlueprint | null>(null);
  const [generation, setGeneration] = useState<GenerationResult | null>(null);
  const [sandboxBuild, setSandboxBuild] = useState<SandboxBuildResult | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: "Describe what you want to build. I’ll plan it, generate the code and backend, compile it in an isolated sandbox, run browser and AI visual QA at desktop/tablet/mobile sizes, repair failures automatically, and open a live preview." },
  ]);
  const [stage, setStage] = useState<BuildStage>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const features = useMemo(() => blueprint?.features.slice(0, 3) ?? ["Dashboard", "Authentication", "Database"], [blueprint]);

  const runPipeline = useCallback(async (content: string) => {
    const clean = content.trim();
    if (clean.length < 10 || busy) return;

    setBusy(true);
    setError("");
    setGeneration(null);
    setSandboxBuild(null);
    setMessages((m) => [...m, { role: "user", text: clean }]);
    setPrompt("");

    try {
      setStage("planning");
      const planData = await postJson("/api/ai/plan", { projectId, prompt: clean }, "The architecture plan failed");
      setBlueprint(planData.blueprint);
      setMessages((m) => [...m, { role: "assistant", text: `Architecture ready: ${planData.blueprint.summary}` }]);

      setStage("generating");
      const generateData = await postJson("/api/ai/generate", { projectId }, "Code generation failed");
      setGeneration(generateData);
      setMessages((m) => [...m, { role: "assistant", text: `Version ${generateData.version.number} generated with ${generateData.files.length} source files.` }]);

      const needsBackend =
        generateData.files.some((file: string) => file.startsWith("supabase/migrations/")) ||
        planData.blueprint.entities.length > 0 ||
        planData.blueprint.roles.length > 0;

      if (needsBackend) {
        setStage("provisioning");
        setMessages((m) => [...m, { role: "assistant", text: "Provisioning an isolated Supabase backend for this application…" }]);
        await provisionBackend(projectId);

        setStage("configuring");
        const configured = await postJson("/api/backends/supabase/configure", { projectId }, "Backend schema configuration failed");
        setMessages((m) => [...m, { role: "assistant", text: `Backend ready. Applied ${configured.appliedMigrations} new database migration${configured.appliedMigrations === 1 ? "" : "s"}; security advisor is clean.` }]);
      }

      setStage("building");
      setMessages((m) => [...m, { role: "assistant", text: "Building in an isolated sandbox, then running Playwright browser QA and AI screenshot review at desktop, tablet, and mobile widths. Supported defects will be repaired automatically." }]);
      const buildData = await postJson("/api/build/run", { projectId }, "Sandbox build or QA failed");
      setSandboxBuild(buildData);
      setStage("ready");
      const scoreText = typeof buildData.visualQa?.score === "number" ? ` Visual quality score: ${buildData.visualQa.score}/100.` : "";
      setMessages((m) => [...m, {
        role: "assistant",
        text: buildData.repairAttempts
          ? `Live preview ready after ${buildData.repairAttempts} automated repair ${buildData.repairAttempts === 1 ? "pass" : "passes"}. Browser and visual QA passed on desktop, tablet, and mobile.${scoreText}`
          : `Build passed on the first attempt. Browser and visual QA passed on desktop, tablet, and mobile.${scoreText} Live preview is ready.`,
      }]);
    } catch (e) {
      const message = e instanceof Error ? e.message : "The build failed";
      setStage("failed");
      setError(message);
      setMessages((m) => [...m, { role: "assistant", text: `Build error: ${message}` }]);
    } finally {
      setBusy(false);
    }
  }, [busy, projectId]);

  useEffect(() => {
    const initial = sessionStorage.getItem(`initial-prompt:${projectId}`);
    if (!initial) return;
    sessionStorage.removeItem(`initial-prompt:${projectId}`);
    const timer = window.setTimeout(() => { void runPipeline(initial); }, 0);
    return () => window.clearTimeout(timer);
  }, [projectId, runPipeline]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">LYMTLESS AI BUILDER</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge">{stage.toUpperCase()}</span>
          {sandboxBuild?.qa?.passed ? <span className="badge">BROWSER QA ✓</span> : null}
          {sandboxBuild?.visualQa?.passed ? <span className="badge">VISUAL {sandboxBuild.visualQa.score ?? "QA"} ✓</span> : null}
          <GithubControls projectId={projectId} versionId={sandboxBuild?.versionId ?? null} />
          {sandboxBuild?.previewUrl ? <a className="secondary-btn" href={sandboxBuild.previewUrl} target="_blank" rel="noreferrer">Open Preview</a> : null}
          <button className="primary-btn" type="button" disabled={stage !== "ready"}>Publish</button>
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
          <div className="preview-toolbar"><span className="status">{previewStatus(stage)}</span><span className="badge">{generation ? `VERSION ${generation.version.number}` : "Desktop"}</span></div>
          <div className="preview-canvas">
            {sandboxBuild?.previewUrl ? (
              <iframe className="live-preview-frame" src={sandboxBuild.previewUrl} title="Generated application live preview" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" referrerPolicy="no-referrer" />
            ) : (
              <div className="browser">
                <div className="browser-top"><span className="dot"/><span className="dot"/><span className="dot"/></div>
                <div className="demo-app">
                  <div style={{ color: '#506078', fontSize: 12, fontWeight: 800, letterSpacing: '.12em' }}>{blueprint?.appType?.toUpperCase() || 'GENERATED APP'}</div>
                  <h2>{blueprint?.name || 'Your application will appear here'}</h2>
                  <p>{blueprint?.summary || 'Describe the application in chat to create its architecture and code.'}</p>
                  <div className="demo-grid">{features.map((f) => <div key={f} className="demo-tile"><strong>{f}</strong><p>Generated module</p></div>)}</div>
                  {blueprint && <div style={{ marginTop: 28 }}><strong>Pages</strong><p>{blueprint.pages.map((p) => p.name).join(' • ')}</p></div>}
                  {generation && <div className="generated-files"><strong>Generated source files</strong><div className="file-grid">{generation.files.slice(0, 18).map((file) => <code key={file}>{file}</code>)}</div>{generation.files.length > 18 && <p>+ {generation.files.length - 18} more files</p>}</div>}
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="agent-panel">
          <div className="agent-header"><strong>AI Builder</strong><div className="status">{stageLabel(stage)}</div></div>
          <div className="agent-log">
            {messages.map((m, i) => <div key={i} className={`message ${m.role === 'assistant' ? 'ai' : 'user'}`}>{m.text}</div>)}
            {stage === "planning" && <div className="message ai">Designing architecture, data model, roles, and integrations…</div>}
            {stage === "generating" && <div className="message ai">Writing the complete application code bundle…</div>}
            {stage === "provisioning" && <div className="message ai">Creating the app’s isolated database/auth/storage project…</div>}
            {stage === "configuring" && <div className="message ai">Applying guarded SQL/RLS and running backend security checks…</div>}
            {stage === "building" && <div className="message ai">Installing, compiling, launching the preview, running browser QA, reviewing screenshots with AI, and repairing supported defects if necessary…</div>}
          </div>
          <div className="composer">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={generation ? "Describe the next change…" : "Build a CRM, booking system, client portal…"} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runPipeline(prompt); } }} />
            <div className="composer-row"><button className="primary-btn" disabled={busy || prompt.trim().length < 10} onClick={() => void runPipeline(prompt)}>{busy ? 'Building…' : generation ? 'Build New Version' : 'Build App'}</button></div>
            {error && <div className="status error" style={{ marginTop: 8 }}>{error}</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

async function postJson(url: string, body: unknown, fallback: string) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    const setup = data.setup ? ` ${data.setup}` : "";
    throw new Error(`${data.error || fallback}${setup}`);
  }
  return data;
}

async function provisionBackend(projectId: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch("/api/backends/supabase/provision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
    const data = await response.json();
    if (response.status === 202) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (!response.ok) {
      const setup = data.setup ? ` ${data.setup}` : "";
      throw new Error(`${data.error || "Backend provisioning failed"}${setup}`);
    }
    return data;
  }
  throw new Error("Backend provisioning is still in progress; try the build again shortly");
}

function stageLabel(stage: BuildStage) {
  if (stage === "planning") return "Architecture agent";
  if (stage === "generating") return "Code-generation agent";
  if (stage === "provisioning") return "Backend provisioning";
  if (stage === "configuring") return "Backend security + schema";
  if (stage === "building") return "Sandbox + browser + visual QA";
  if (stage === "ready") return "Live preview ready";
  if (stage === "failed") return "Build failed";
  return "Ready for prompt";
}

function previewStatus(stage: BuildStage) {
  if (stage === "provisioning") return "Provisioning isolated app backend…";
  if (stage === "configuring") return "Configuring database and RLS…";
  if (stage === "building") return "Building and visually validating isolated preview…";
  if (stage === "ready") return "QA-passed live sandbox preview";
  if (stage === "generating") return "Generating application files…";
  return "Application Preview";
}