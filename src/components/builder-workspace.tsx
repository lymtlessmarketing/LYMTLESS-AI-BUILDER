"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppBlueprint } from "@/lib/ai/schemas";

export type ChatMessage = { role: "user" | "assistant"; text: string };
type BuildStage = "idle" | "planning" | "generating" | "previewing" | "repairing" | "ready" | "failed";
type FailureStage = "planning" | "generating" | "previewing" | "repairing" | null;
type Viewport = "desktop" | "tablet" | "mobile";
type GenerationResult = {
  version: { id: string; number: number; summary: string };
  files: string[];
};
type PreviewResult = { previewUrl: string; sandboxName: string; versionId: string };

export type BuilderInitialState = {
  project: {
    name: string;
    description: string | null;
    status: string;
    githubRepoFullName: string | null;
    productionUrl: string | null;
  };
  blueprint: AppBlueprint | null;
  generation: GenerationResult | null;
  preview: PreviewResult | null;
  messages: ChatMessage[];
};

const MAX_PROMPT_CHARS = 120_000;
const LONG_MESSAGE_PREVIEW = 1_600;

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
const defaultMessage: ChatMessage = {
  role: "assistant",
  text: "Describe what you want to build. I’ll plan the architecture, generate the application, compile it in isolation, repair failures if needed, and launch a live preview.",
};

type ApiPayload = Record<string, unknown> & {
  error?: string;
  details?: unknown;
};

async function readApiPayload(response: Response): Promise<ApiPayload> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as ApiPayload;
  } catch {
    return { error: response.ok ? "The server returned an unreadable response." : `Request failed with HTTP ${response.status}.` };
  }
}

function apiError(payload: ApiPayload, fallback: string) {
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  return fallback;
}

export function BuilderWorkspace({ projectId, initialState }: { projectId: string; initialState: BuilderInitialState }) {
  const [prompt, setPrompt] = useState("");
  const [blueprint, setBlueprint] = useState<AppBlueprint | null>(initialState.blueprint);
  const [generation, setGeneration] = useState<GenerationResult | null>(initialState.generation);
  const [preview, setPreview] = useState<PreviewResult | null>(initialState.preview);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [messages, setMessages] = useState<ChatMessage[]>(initialState.messages.length ? initialState.messages : [defaultMessage]);
  const [stage, setStage] = useState<BuildStage>(() => initialStage(initialState));
  const [failedAt, setFailedAt] = useState<FailureStage>(() => initialState.project.status === "failed" ? inferFailureStage(initialState) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialState.project.status === "failed" ? "The previous build attempt failed. You can retry from the current state." : "");

  const features = useMemo(
    () => blueprint?.features.slice(0, 3) ?? ["Dashboard", "Authentication", "Database"],
    [blueprint],
  );

  const startPreview = useCallback(async () => {
    setPreview(null);
    setError("");
    setFailedAt(null);
    let repairAttempts = 0;

    while (repairAttempts <= 2) {
      const previewStage: FailureStage = repairAttempts === 0 ? "previewing" : "repairing";
      setStage(previewStage);

      const previewRes = await fetch("/api/sandbox/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const previewData = await readApiPayload(previewRes);

      if (previewRes.ok) {
        const nextPreview = previewData as unknown as PreviewResult;
        setPreview(nextPreview);
        setStage("ready");
        setFailedAt(null);
        setError("");
        setMessages((m) => [...m, {
          role: "assistant",
          text: `Build passed${repairAttempts ? ` after ${repairAttempts} repair attempt${repairAttempts === 1 ? "" : "s"}` : ""}. The live application preview is running in an isolated sandbox.`,
        }]);
        return;
      }

      const logs = typeof previewData.logs === "string" ? previewData.logs : "";
      if (previewRes.status !== 422 || !logs || repairAttempts >= 2) {
        setFailedAt(previewStage);
        throw new Error(`${apiError(previewData, "Sandbox preview failed")}${logs ? `\n${logs}` : ""}`);
      }

      repairAttempts += 1;
      setStage("repairing");
      setMessages((m) => [...m, { role: "assistant", text: `Sandbox build failed. Auto-repair attempt ${repairAttempts} of 2 is analyzing the compiler logs…` }]);

      const repairRes = await fetch("/api/ai/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, logs }),
      });
      const repairData = await readApiPayload(repairRes);
      if (!repairRes.ok) {
        setFailedAt("repairing");
        throw new Error(apiError(repairData, "Automatic repair failed"));
      }

      const repairVersion = repairData.version as { id: string; number: number } | undefined;
      const repairSummary = typeof repairData.summary === "string" ? repairData.summary : "Compiler repair";
      if (repairVersion) {
        setGeneration((current) => current ? {
          ...current,
          version: { id: repairVersion.id, number: repairVersion.number, summary: repairSummary },
        } : current);
      }
      setMessages((m) => [...m, { role: "assistant", text: `Repair version ${repairVersion?.number ?? "created"}: ${repairSummary}` }]);
    }
  }, [projectId]);

  const runPipeline = useCallback(async (content: string) => {
    const clean = content.trim();
    if (busy) return;
    if (clean.length < 10) {
      setError("Describe the application in at least 10 characters.");
      return;
    }
    if (clean.length > MAX_PROMPT_CHARS) {
      setError(`Prompt is too long. Maximum ${MAX_PROMPT_CHARS.toLocaleString()} characters.`);
      return;
    }

    setBusy(true);
    setError("");
    setFailedAt(null);
    setPreview(null);
    setMessages((m) => [...m, { role: "user", text: clean }]);
    setPrompt("");

    let currentFailureStage: FailureStage = "planning";

    try {
      setStage("planning");
      const planningPrompt = blueprint && generation
        ? [
            "Modify the existing application without dropping unrelated behavior.",
            "EXISTING APPLICATION BLUEPRINT:",
            JSON.stringify(blueprint, null, 2),
            "CHANGE REQUEST:",
            clean,
            "Return a complete revised blueprint that preserves existing requirements unless the change request explicitly replaces them.",
          ].join("\n\n")
        : clean;

      if (planningPrompt.length > MAX_PROMPT_CHARS) {
        throw new Error(`The combined change request exceeds ${MAX_PROMPT_CHARS.toLocaleString()} characters. Shorten the change request and try again.`);
      }

      const planRes = await fetch("/api/ai/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, prompt: planningPrompt }),
      });
      const planData = await readApiPayload(planRes);
      if (!planRes.ok) throw new Error(apiError(planData, "The architecture plan failed"));
      const nextBlueprint = planData.blueprint as AppBlueprint | undefined;
      if (!nextBlueprint) throw new Error("The architecture endpoint returned no blueprint.");
      setBlueprint(nextBlueprint);
      setMessages((m) => [...m, { role: "assistant", text: `Architecture ready: ${nextBlueprint.summary}` }]);

      currentFailureStage = "generating";
      setStage("generating");
      const generateRes = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const generateData = await readApiPayload(generateRes);
      if (!generateRes.ok) throw new Error(apiError(generateData, "Code generation failed"));

      const nextGeneration = generateData as unknown as GenerationResult;
      if (!nextGeneration.version || !Array.isArray(nextGeneration.files)) {
        throw new Error("The generation endpoint returned an incomplete source bundle response.");
      }
      setGeneration(nextGeneration);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Version ${nextGeneration.version.number} generated with ${nextGeneration.files.length} files. Compiling it now…` },
      ]);

      currentFailureStage = "previewing";
      await startPreview();
    } catch (e) {
      const message = e instanceof Error ? e.message : "The build failed";
      setStage("failed");
      setFailedAt((current) => current ?? currentFailureStage);
      setError(message);
      setMessages((m) => [...m, { role: "assistant", text: `Build error: ${message.slice(0, 1_500)}` }]);
    } finally {
      setBusy(false);
    }
  }, [blueprint, busy, generation, projectId, startPreview]);

  const retryPreview = useCallback(async () => {
    if (busy || !generation) return;
    setBusy(true);
    setError("");
    try {
      await startPreview();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Preview failed";
      setStage("failed");
      setFailedAt((current) => current ?? "previewing");
      setError(message);
      setMessages((m) => [...m, { role: "assistant", text: `Build error: ${message.slice(0, 1_500)}` }]);
    } finally {
      setBusy(false);
    }
  }, [busy, generation, startPreview]);

  useEffect(() => {
    const initial = sessionStorage.getItem(`initial-prompt:${projectId}`);
    if (!initial) return;
    sessionStorage.removeItem(`initial-prompt:${projectId}`);
    void runPipeline(initial);
  }, [projectId, runPipeline]);

  const progress = stageProgress(stage, failedAt);
  const projectName = blueprint?.name || initialState.project.name || "Untitled Build";
  const promptCount = prompt.length;
  const githubUrl = initialState.project.githubRepoFullName
    ? `https://github.com/${initialState.project.githubRepoFullName}`
    : null;

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
          <span className="studio-stage-pill"><i />{stageLabel(stage, failedAt)}</span>
          {githubUrl ? (
            <a className="studio-btn" href={githubUrl} target="_blank" rel="noreferrer">GitHub ↗</a>
          ) : (
            <button className="studio-btn" type="button" disabled title="GitHub repository has not been connected to this project yet.">GitHub</button>
          )}
          {initialState.project.productionUrl ? (
            <a className="studio-btn studio-btn-primary" href={initialState.project.productionUrl} target="_blank" rel="noreferrer">Open live ↗</a>
          ) : (
            <button className="studio-btn studio-btn-primary" type="button" disabled title="Production publishing is not connected yet.">Publish ↗</button>
          )}
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
              <button key={label} className={`studio-side-item ${index === 0 ? "active" : ""}`} type="button" disabled={index !== 0} title={index === 0 ? "Live preview" : `${label} workspace — next milestone`}>
                <span className="studio-side-icon">{icon}</span>{label}
              </button>
            ))}
          </div>
          <div className="studio-side-section">
            <div className="studio-side-title">Developer</div>
            {devNav.map(([icon, label]) => (
              <button key={label} className="studio-side-item" type="button" disabled title={`${label} workspace — next milestone`}>
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
              <span>{preview?.previewUrl || (stage === "previewing" ? "Installing dependencies and compiling…" : stage === "repairing" ? "Repairing failed build…" : generation ? "Generated source is ready for sandbox verification" : "Waiting for a successful sandbox build")}</span>
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
                    <p>{blueprint?.summary || initialState.project.description || "Describe the application in the AI panel. LYMTLESS will architect it, generate the source, compile it in an isolated sandbox, and replace this canvas with the working product."}</p>

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
              <button type="button" key={tab} disabled={index !== 0} className={`studio-bottom-tab ${index === 0 ? "active" : ""}`} title={index === 0 ? "Preview" : `${tab} view — next milestone`}>{tab}</button>
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
              <div key={`${index}-${message.role}`} className={`studio-message ${message.role === "assistant" ? "ai" : "user"}`}>
                <span className="studio-message-label">{message.role === "assistant" ? "LYMTLESS" : "YOU"}</span>
                <MessageBody text={message.text} />
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
                maxLength={MAX_PROMPT_CHARS}
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
                <span className="studio-composer-hint">
                  ENTER TO SEND · SHIFT+ENTER FOR NEW LINE · {promptCount.toLocaleString()}/{MAX_PROMPT_CHARS.toLocaleString()}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  {generation && !busy && !preview && (
                    <button className="studio-btn" type="button" onClick={() => void retryPreview()}>Retry preview</button>
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

function MessageBody({ text }: { text: string }) {
  if (text.length <= LONG_MESSAGE_PREVIEW) return <>{text}</>;
  return (
    <div>
      <p style={{ margin: 0 }}>{text.slice(0, LONG_MESSAGE_PREVIEW)}…</p>
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer" }}>Show full message · {text.length.toLocaleString()} characters</summary>
        <div style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{text}</div>
      </details>
    </div>
  );
}

function WorkingMessage({ text }: { text: string }) {
  return <div className="studio-message ai studio-thinking"><i />{text}</div>;
}

function initialStage(initialState: BuilderInitialState): BuildStage {
  if (initialState.preview) return "ready";
  if (initialState.project.status === "failed") return "failed";
  return "idle";
}

function inferFailureStage(initialState: BuilderInitialState): FailureStage {
  if (initialState.generation) return "previewing";
  if (initialState.blueprint) return "generating";
  return "planning";
}

function stageProgress(stage: BuildStage, failedAt: FailureStage) {
  if (stage === "planning") return 0;
  if (stage === "generating") return 1;
  if (stage === "previewing") return 2;
  if (stage === "repairing") return 3;
  if (stage === "ready") return 5;
  if (stage === "failed") {
    if (failedAt === "planning") return 0;
    if (failedAt === "generating") return 1;
    if (failedAt === "previewing") return 2;
    if (failedAt === "repairing") return 3;
  }
  return 0;
}

function stageLabel(stage: BuildStage, failedAt: FailureStage) {
  if (stage === "planning") return "Architecture";
  if (stage === "generating") return "Generating";
  if (stage === "previewing") return "Sandbox build";
  if (stage === "repairing") return "Repairing";
  if (stage === "ready") return "Preview ready";
  if (stage === "failed") {
    if (failedAt === "planning") return "Plan failed";
    if (failedAt === "generating") return "Generation failed";
    if (failedAt === "repairing") return "Repair failed";
    return "Sandbox failed";
  }
  return "Ready";
}
