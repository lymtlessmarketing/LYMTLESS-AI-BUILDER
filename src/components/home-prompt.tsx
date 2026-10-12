"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const examples = [
  "CRM",
  "Client portal",
  "Booking app",
  "Internal dashboard",
];

export function HomePrompt() {
  const [prompt, setPrompt] = useState("Build a multi-user CRM with leads, pipeline stages, tasks, role-based permissions, and a dashboard.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function create() {
    setBusy(true);
    setError("");
    try {
      const projectRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Untitled App" }),
      });
      const projectData = await projectRes.json();
      if (!projectRes.ok) throw new Error(projectData.error || "Could not create project");
      sessionStorage.setItem(`initial-prompt:${projectData.project.id}`, prompt);
      router.push(`/builder/${projectData.project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="prompt-surface">
      <div className="prompt-topline">
        <div>
          <span className="prompt-label">What do you want to build?</span>
          <span className="prompt-hint">Describe the product, workflow, or business tool.</span>
        </div>
        <span className="prompt-mode">FULL STACK</span>
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        aria-label="Describe your app"
        placeholder="Describe your app..."
      />

      <div className="prompt-footer">
        <div className="prompt-meta">
          <span className={`prompt-status ${error ? "error" : ""}`}>
            {error || "Database · Auth · Backend · UI · Deploy"}
          </span>
          <div className="example-chips" aria-label="Example app types">
            {examples.map((example) => (
              <button
                type="button"
                className="example-chip"
                key={example}
                onClick={() => setPrompt(`Build a polished ${example.toLowerCase()} with authentication, database, responsive UI, and production-ready workflows.`)}
              >
                {example}
              </button>
            ))}
          </div>
        </div>

        <button
          className="build-button"
          disabled={busy || prompt.trim().length < 10}
          onClick={create}
        >
          <span>{busy ? "Creating…" : "Build app"}</span>
          <span className="build-arrow" aria-hidden="true">↗</span>
        </button>
      </div>
    </div>
  );
}
