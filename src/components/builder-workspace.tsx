"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppBlueprint } from "@/lib/ai/schemas";

type ChatMessage = { role: "user" | "assistant"; text: string };
type BuildStage = "idle" | "planning" | "generating" | "previewing" | "repairing" | "ready" | "failed";
type GenerationResult = {
  version: { id: string; number: number; summary: string };
  files: string[];
};
type PreviewResult = { previewUrl: string; sandboxName: string; versionId: string };

export function BuilderWorkspace({ projectId }: { projectId: string }) {
  const [prompt, setPrompt] = useState("");
  const [blueprint, setBlueprint] = useState<AppBlueprint | null>(null);
  const [generation, setGeneration] = useState<GenerationResult | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: "Describe what you want to build. I’ll plan, generate, compile, repair if needed, and launch a live preview." },
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">LYMTLESS AI BUILDER</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge">{stage.toUpperCase()}</span>
          <button className="secondary-btn" type="button">GitHub</button>
          <button className="primary-btn" type="button" disabled={stage !== "ready"}>Publish</button>
        </div>
      </header>
      <div className="builder">
        <aside className="sidebar">
          <div className="side-title">BUILD</div>
          {["Preview","Pages","Components","Database","Authentication","Storage","Functions","Integrations"].map((x, i) => (
            <div key={x} className={`side-item ${i === 0 ? "active" : ""}`}>{x}</div>
          ))}
          <div className="side-title">DEVELOPER</div>
          {["Code","Console","Logs","Versions","Deployments","Settings"].map((x) => (
            <div key={x} className="side-item">{x}</div>
          ))}
        </aside>

        <section className="preview-wrap">
          <div className="preview-toolbar">
            <span className="status">{preview ? "Live Sandbox Preview" : stage === "previewing" ? "Installing dependencies and compiling…" : stage === "repairing" ? "Repairing build…" : "Application Preview"}</span>
            <span className="badge">{generation ? `VERSION ${generation.version.number}` : "Desktop"}</span>
          </div>
          <div className="preview-canvas">
            <div className="browser">
              <div className="browser-top"><span className="dot"/><span className="dot"/><span className="dot"/></div>
              {preview ? (
                <iframe
                  title="Generated application preview"
                  src={preview.previewUrl}
                  style={{ width: "100%", minHeight: "720px", border: 0, background: "white" }}
                  sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                />
              ) : (
                <div className="demo-app">
                  <div style={{ color: "#506078", fontSize: 12, fontWeight: 800, letterSpacing: ".12em" }}>
                    {blueprint?.appType?.toUpperCase() || "GENERATED APP"}
                  </div>
                  <h2>{blueprint?.name || "Your application will appear here"}</h2>
                  <p>{blueprint?.summary || "Describe the application in chat to create its architecture and code."}</p>
                  <div className="demo-grid">
                    {features.map((f) => <div key={f} className="demo-tile"><strong>{f}</strong><p>Generated module</p></div>)}
                  </div>
                  {blueprint && <div style={{ marginTop: 28 }}><strong>Pages</strong><p>{blueprint.pages.map((p) => p.name).join(" • ")}</p></div>}
                  {generation && (
                    <div className="generated-files">
                      <strong>Generated source files</strong>
                      <div className="file-grid">{generation.files.slice(0, 18).map((file) => <code key={file}>{file}</code>)}</div>
                      {generation.files.length > 18 && <p>+ {generation.files.length - 18} more files</p>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="agent-panel">
          <div className="agent-header"><strong>AI Builder</strong><div className="status">{stageLabel(stage)}</div></div>
          <div className="agent-log">
            {messages.map((m, i) => <div key={i} className={`message ${m.role === "assistant" ? "ai" : "user"}`}>{m.text}</div>)}
            {stage === "planning" && <div className="message ai">Designing architecture, data model, roles, and integrations…</div>}
            {stage === "generating" && <div className="message ai">Writing the complete application code bundle…</div>}
            {stage === "previewing" && <div className="message ai">Running npm install, production build, health check, and isolated preview server…</div>}
            {stage === "repairing" && <div className="message ai">Reading actual sandbox errors, patching affected files, and creating a new version…</div>}
          </div>
          <div className="composer">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={generation ? "Describe the next change…" : "Build a CRM, booking system, client portal…"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void runPipeline(prompt);
                }
              }}
            />
            <div className="composer-row">
              <button className="primary-btn" disabled={busy || prompt.trim().length < 10} onClick={() => void runPipeline(prompt)}>
                {busy ? "Building…" : generation ? "Regenerate" : "Build App"}
              </button>
              {generation && !busy && !preview && (
                <button className="secondary-btn" type="button" onClick={() => void startPreview().catch((e) => setError(e instanceof Error ? e.message : "Preview failed"))}>
                  Retry Preview
                </button>
              )}
            </div>
            {error && <div className="status error" style={{ marginTop: 8, whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto" }}>{error}</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function stageLabel(stage: BuildStage) {
  if (stage === "planning") return "Architecture agent";
  if (stage === "generating") return "Code-generation agent";
  if (stage === "previewing") return "Sandbox build";
  if (stage === "repairing") return "Repair agent";
  if (stage === "ready") return "Live preview ready";
  if (stage === "failed") return "Build failed";
  return "Ready for prompt";
}
