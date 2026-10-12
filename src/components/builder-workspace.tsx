"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppBlueprint } from "@/lib/ai/schemas";

type ChatMessage = { role: "user" | "assistant"; text: string };
type BuildStage = "idle" | "planning" | "generating" | "previewing" | "repairing" | "ready" | "failed";
type Viewport = "desktop" | "tablet" | "mobile";
type GenerationResult = {
  version: { id: string; number: number; summary: string };
  files: string[];
};
type PreviewResult = { previewUrl: string; sandboxName: string; versionId: string };

const buildNav = [
  ["◫", "Preview"],
  ["◩", "Pages"],
  ["◇", "Components"],
  ["▦", "Database"],
  ["◎", "Authentication"],
  ["□", "Storage"],
  ["ƒ", "Functions"],
  ["↗", "Integrations"],
] as const;

const devNav = [
  ["</>", "Code"],
  [">_", "Console"],
  ["≡", "Logs"],
  ["↺", "Versions"],
  ["⇧", "Deployments"],
  ["⚙", "Settings"],
] as const;

const stageSteps = ["Plan", "Generate", "Sandbox", "Repair", "Preview", "Publish"];

export function BuilderWorkspace({ projectId }: { projectId: string }) {
  const [prompt, setPrompt] = useState("");
  const [blueprint, setBlueprint] = useState<AppBlueprint | null>(null);
  const [generation, setGeneration] = useState<GenerationResult | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: "Describe what you want to build. I’ll plan the architecture, generate the application, compile it in isolation, repair failures if needed, and launch a live preview." },
  ]);
  const [stage, setStage] = useState<BuildStage>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const features = useMemo(
    () => blueprint?.features.slice(0, 3) ?? ["Dashboard", "Authentication", "Database"],
    [blueprint],
  );

  const startPreview = useCallback(async () => {
    setPreview(null);
    let repairAttempts = 0;

    while (repairAttempts <= 2) {
      setStage(repairAttempts === 0 ? "previewing" : "repairing");
      const previewRes = await fetch("/api/sandbox/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const previewData = await previewRes.json();

      if (previewRes.ok) {
        setPreview(previewData);
        setStage("ready");
        setMessages((m) => [...m, { role: "assistant", text: `Build passed${repairAttempts ? ` after ${repairAttempts} repair attempt${repairAttempts === 1 ? "" : "s"}` : ""}. The live application preview is running in an isolated sandbox.` }]);
        return;
      }

      const logs = typeof previewData.logs === "string" ? previewData.logs : "";
      if (previewRes.status !== 422 || !logs || repairAttempts >= 2) {
        throw new Error(`${previewData.error || "Sandbox preview failed"}${logs ? `\n${logs}` : ""}`);
      }

      repairAttempts += 1;
      setStage("repairing");
      setMessages((m) => [...m, { role: "assistant", text: `Sandbox build failed. Auto-repair attempt ${repairAttempts} of 2 is analyzing the compiler logs…` }]);

      const repairRes = await fetch("/api/ai/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, logs }),
      });
      const repairData = await repairRes.json();
      if (!repairRes.ok) throw new Error(repairData.error || "Automatic repair failed");
      setMessages((m) => [...m, { role: "assistant", text: `Repair version ${repairData.version.number} created: ${repairData.summary}` }]);
    }
  }, [projectId]);

  const runPipeline = useCallback(async (content: string) => {
    const clean = content.trim();
    if (clean.length < 10 || busy) return;

    setBusy(true);
    setError("");
    setGeneration(null);
    setPreview(null);
    setMessages((m) => [...m, { role: "user", text: clean }]);
    setPrompt("");

    try {
      setStage("planning");
      const planRes = await fetch("/api/ai/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, prompt: clean }),
      });
      const planData = await planRes.json();
      if (!planRes.ok) throw new Error(planData.error || "The architecture plan failed");
      setBlueprint(planData.blueprint);
      setMessages((m) => [...m, { role: "assistant", text: `Architecture ready: ${planData.blueprint.summary}` }]);

      setStage("generating");
      const generateRes = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const generateData = await generateRes.json();
      if (!generateRes.ok) throw new Error(generateData.error || "Code generation failed");

      setGeneration(generateData);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Version ${generateData.version.number} generated with ${generateData.files.length} files. Compiling it now…` },
      ]);

      await startPreview();
    } catch (e) {
      const message = e instanceof Error ? e.message : "The build failed";
      setStage("failed");
      setError(message);
      setMessages((m) => [...m, { role: "assistant", text: `Build error: ${message.slice(0, 900)}` }]);
    } finally {
      setBusy(false);
    }
  }, [busy, projectId, startPreview]);

  useEffect(() => {
    const initial = sessionStorage.getItem(`initial-prompt:${projectId}`);
    if (!initial) return;
    sessionStorage.removeItem(`initial-prompt:${projectId}`);
    void runPipeline(initial);
  }, [projectId, runPipeline]);

  const progress = stageProgress(stage);
  const projectName = blueprint?.name || "Untitled Build";

  return (
    <div className="studio-shell">
      <header className="studio-topbar">
        <div className="studio-brand">
          <div className="studio-mark">L</div>
          <div className="studio-brand-copy">
            <strong>LYMTLESS</strong>
            <span>AI BUILDER / STUDIO</span>
          </div>
        </div>

        <div className="studio-project-bar">
          <span className="studio-breadcrumb">Projects /</span>
          <strong className="studio-project-name">{projectName}</strong>
          <span className="studio-project-id">{projectId.slice(0, 8).toUpperCase()}</span>
        </div>

        <div className="studio-actions">
          <span className="studio-stage-pill"><i />{stageLabel(stage)}</span>
          <button className="studio-btn" type="button">GitHub</button>
          <button className="studio-btn studio-btn-primary" type="button" disabled={stage !== "ready"}>Publish ↗</button>
        </div>
      </header>

      <div className="studio-stage-rail" aria-label="Build progress">
        {stageSteps.map((step, index) => (
          <div
            key={step}
            className={`studio-stage-step ${index < progress ? "is-complete" : ""} ${index === progress && stage !== "idle" && stage !== "failed" ? "is-active" : ""}`}
          >
            {step}
          </div>
        ))}
      </div>

      <div className="studio-grid">
        <aside className="studio-sidebar">
          <div className="studio-side-section">
            <div className="studio-side-title">Build</div>
            {buildNav.map(([icon, label], index) => (
              <button key={label} className={`studio-side-item ${index === 0 ? "active" : ""}`} type="button" title={index === 0 ? "Live preview" : `${label} workspace — next milestone`}>
                <span className="studio-side-icon">{icon}</span>{label}
              </button>
            ))}
          </div>
          <div className="studio-side-section">
            <div className="studio-side-title">Developer</div>
            {devNav.map(([icon, label]) => (
              <button key={label} className="studio-side-item" type="button" title={`${label} workspace — next milestone`}>
                <span className="studio-side-icon">{icon}</span>{label}
              </button>
            ))}
          </div>
          <div className="studio-sidebar-foot">
            <strong>CONTROL PLANE</strong>
            <p>Supabase · GitHub · Vercel Sandbox connected to this build environment.</p>
          </div>
        </aside>

        <section className="studio-main">
          <div className="studio-preview-toolbar">
            <div className="studio-preview-title">
              <strong>{preview ? "Live application" : "Application preview"}</strong>
              <span>{preview?.previewUrl || (stage === "previewing" ? "Installing dependencies and compiling…" : stage === "repairing" ? "Repairing failed build…" : "Waiting for a successful sandbox build")}</span>
            </div>

            <div className="studio-device-switch" aria-label="Preview viewport">
              <button className={`studio-device-button ${viewport === "desktop" ? "active" : ""}`} onClick={() => setViewport("desktop")} type="button" title="Desktop">▭</button>
              <button className={`studio-device-button ${viewport === "tablet" ? "active" : ""}`} onClick={() => setViewport("tablet")} type="button" title="Tablet">▱</button>
              <button className={`studio-device-button ${viewport === "mobile" ? "active" : ""}`} onClick={() => setViewport("mobile")} type="button" title="Mobile">▯</button>
            </div>

            <div className="studio-preview-meta">
              <span className="studio-mini-pill">{generation ? `V${generation.version.number}` : "Draft"}</span>
              <span className="studio-mini-pill">{viewport}</span>
            </div>
          </div>

          <div className="studio-canvas">
            <div className={`studio-browser-wrap viewport-${viewport}`}>
              <div className="studio-browser">
                <div className="studio-browser-top">
                  <div className="studio-browser-dots"><i /><i /><i /></div>
                  <div className="studio-address">{preview?.previewUrl || "preview.lymtless.build"}</div>
                  {preview ? <a className="studio-open-preview" href={preview.previewUrl} target="_blank" rel="noreferrer" title="Open preview in new tab">↗</a> : <span className="studio-open-preview">↗</span>}
                </div>

                {preview ? (
                  <iframe
                    title="Generated application preview"
                    src={preview.previewUrl}
                    className="studio-iframe"
                    sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                  />
                ) : (
                  <div className="studio-empty-preview">
                    <span className="studio-empty-eyebrow">{blueprint?.appType?.toUpperCase() || "LYMTLESS GENERATED APPLICATION"}</span>
                    <h2>{blueprint?.name || "Your application will materialize here."}</h2>
                    <p>{blueprint?.summary || "Describe the application in the AI panel. LYMTLESS will architect it, generate the source, compile it in an isolated sandbox, and replace this canvas with the working product."}</p>

                    <div className="studio-demo-grid">
                      {features.map((feature) => (
                        <div key={feature} className="studio-demo-card">
                          <strong>{feature}</strong>
                          <p>Generated module</p>
                        </div>
                      ))}
                    </div>

                    {blueprint && (
                      <div className="studio-file-block">
                        <strong>Planned pages</strong>
                        <p>{blueprint.pages.map((page) => page.name).join(" · ")}</p>
                      </div>
                    )}

                    {generation && (
                      <div className="studio-file-block">
                        <strong>Generated source / {generation.files.length} files</strong>
                        <div className="studio-file-grid">
                          {generation.files.slice(0, 18).map((file) => <code key={file}>{file}</code>)}
                        </div>
                        {generation.files.length > 18 && <p>+ {generation.files.length - 18} additional files</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="studio-bottom-tabs" aria-label="Workspace views">
            {['Preview', 'Code', 'Database', 'Logs', 'GitHub', 'Versions'].map((tab, index) => (
              <button type="button" key={tab} className={`studio-bottom-tab ${index === 0 ? "active" : ""}`} title={index === 0 ? "Preview" : `${tab} view — next milestone`}>{tab}</button>
            ))}
          </div>
        </section>

        <aside className="studio-agent">
          <div className="studio-agent-head">
            <div className="studio-agent-title">
              <strong>Builder Agent</strong>
              <span>{busy ? "Working" : "Online"}</span>
            </div>
            <div className="studio-agent-sub">Architecture, generation, sandbox validation and repair in one continuous build thread.</div>
          </div>

          <div className="studio-agent-log">
            {messages.map((message, index) => (
              <div key={index} className={`studio-message ${message.role === "assistant" ? "ai" : "user"}`}>
                <span className="studio-message-label">{message.role === "assistant" ? "LYMTLESS" : "YOU"}</span>
                {message.text}
              </div>
            ))}
            {stage === "planning" && <WorkingMessage text="Designing architecture, data model, roles and integrations…" />}
            {stage === "generating" && <WorkingMessage text="Writing the complete application source bundle…" />}
            {stage === "previewing" && <WorkingMessage text="Installing dependencies, running the production build and launching the isolated preview…" />}
            {stage === "repairing" && <WorkingMessage text="Reading sandbox compiler output, patching affected files and creating a repaired version…" />}
          </div>

          <div className="studio-composer">
            <div className="studio-composer-shell">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={generation ? "Describe the next change you want…" : "Build a CRM, client portal, marketplace, operations system…"}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void runPipeline(prompt);
                  }
                }}
              />
              <div className="studio-composer-row">
                <span className="studio-composer-hint">ENTER TO SEND · SHIFT+ENTER FOR NEW LINE</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {generation && !busy && !preview && (
                    <button className="studio-btn" type="button" onClick={() => void startPreview().catch((e) => setError(e instanceof Error ? e.message : "Preview failed"))}>Retry</button>
                  )}
                  <button className="studio-btn studio-btn-primary" disabled={busy || prompt.trim().length < 10} onClick={() => void runPipeline(prompt)}>
                    {busy ? "Building…" : generation ? "Apply change ↗" : "Build app ↗"}
                  </button>
                </div>
              </div>
            </div>
            {error && <div className="studio-error">{error}</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function WorkingMessage({ text }: { text: string }) {
  return <div className="studio-message ai studio-thinking"><i />{text}</div>;
}

function stageProgress(stage: BuildStage) {
  if (stage === "planning") return 0;
  if (stage === "generating") return 1;
  if (stage === "previewing") return 2;
  if (stage === "repairing") return 3;
  if (stage === "ready") return 4;
  if (stage === "failed") return 2;
  return 0;
}

function stageLabel(stage: BuildStage) {
  if (stage === "planning") return "Architecture";
  if (stage === "generating") return "Generating";
  if (stage === "previewing") return "Sandbox build";
  if (stage === "repairing") return "Repairing";
  if (stage === "ready") return "Preview ready";
  if (stage === "failed") return "Build failed";
  return "Ready";
}
