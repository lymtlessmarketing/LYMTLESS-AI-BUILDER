"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const MAX_PROMPT_CHARS = 120_000;
const PENDING_PROMPT_KEY = "pending-build-prompt";

const examples = [
  ["01", "CRM"],
  ["02", "CLIENT PORTAL"],
  ["03", "OPERATIONS OS"],
  ["04", "MARKETPLACE"],
];

async function readPayload(response: Response) {
  const text = await response.text();
  if (!text) return {} as { error?: string; project?: { id: string } };
  try {
    return JSON.parse(text) as { error?: string; project?: { id: string } };
  } catch {
    return { error: `Request failed with HTTP ${response.status}.` };
  }
}

export function HomePrompt() {
  const [prompt, setPrompt] = useState("Build a multi-user CRM with leads, pipeline stages, tasks, role-based permissions, and a dashboard.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function create() {
    const clean = prompt.trim();
    if (clean.length < 10) return setError("Describe the application in at least 10 characters.");
    if (clean.length > MAX_PROMPT_CHARS) return setError(`Prompt is too long. Maximum ${MAX_PROMPT_CHARS.toLocaleString()} characters.`);

    setBusy(true);
    setError("");
    try {
      const projectRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Untitled App" }),
      });
      const projectData = await readPayload(projectRes);

      if (projectRes.status === 401) {
        sessionStorage.setItem(PENDING_PROMPT_KEY, clean);
        router.push("/login");
        return;
      }

      if (!projectRes.ok || !projectData.project?.id) throw new Error(projectData.error || "Could not create project");
      sessionStorage.setItem(`initial-prompt:${projectData.project.id}`, clean);
      router.push(`/builder/${projectData.project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create project");
    } finally {
      setBusy(false);
    }
  }

  function useExample(example: string) {
    const prompts: Record<string, string> = {
      CRM: "Build a premium multi-user CRM with lead management, pipeline stages, tasks, permissions, reporting, and a polished executive dashboard.",
      "CLIENT PORTAL": "Build a high-end client portal with authentication, projects, files, invoices, messaging, approvals, and a refined responsive interface.",
      "OPERATIONS OS": "Build an internal operations system with role-based access, workflows, requests, tasks, dashboards, notifications, and audit history.",
      MARKETPLACE: "Build a two-sided marketplace with buyer and seller accounts, listings, search, payments, messaging, reviews, and admin controls.",
    };
    setPrompt(prompts[example] || prompt);
  }

  return (
    <div className="cr-prompt-shell">
      <div className="cr-prompt-head">
        <span>LYMTLESS ENGINE / FULL STACK</span>
        <span className="cr-ready"><i /> READY</span>
      </div>

      <div className="cr-prompt-main">
        <span className="cr-overline">DESCRIBE WHAT YOU WANT TO BUILD</span>
        <textarea
          value={prompt}
          maxLength={MAX_PROMPT_CHARS}
          onChange={(e) => setPrompt(e.target.value)}
          aria-label="Describe your app"
          placeholder="Describe the product you want to build..."
        />
      </div>

      <div className="cr-prompt-presets">
        {examples.map(([number, label]) => (
          <button type="button" key={label} onClick={() => useExample(label)}>
            <span>{number}</span>{label}
          </button>
        ))}
      </div>

      <div className="cr-prompt-foot">
        <span className={`cr-runtime ${error ? "error" : ""}`}>
          {error || `ARCHITECTURE · DATABASE · AUTH · UI · LOGIC · BUILD · DEPLOY · ${prompt.length.toLocaleString()}/${MAX_PROMPT_CHARS.toLocaleString()}`}
        </span>
        <button className="cr-build-button" disabled={busy || prompt.trim().length < 10} onClick={create}>
          {busy ? "CREATING…" : "BUILD THE APP"}<span>↗</span>
        </button>
      </div>
    </div>
  );
}
