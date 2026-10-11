"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
    <div className="card prompt-card">
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Describe your app" />
      <div className="prompt-actions">
        <span className={`status ${error ? "error" : ""}`}>{error || "Full-stack generation • Supabase • GitHub-ready"}</span>
        <button className="primary-btn" disabled={busy || prompt.trim().length < 10} onClick={create}>
          {busy ? "Creating…" : "Build App"}
        </button>
      </div>
    </div>
  );
}
