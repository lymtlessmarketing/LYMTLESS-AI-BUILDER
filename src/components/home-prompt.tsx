"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const examples = [
  ["01", "CRM"],
  ["02", "CLIENT PORTAL"],
  ["03", "OPERATIONS OS"],
  ["04", "MARKETPLACE"],
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
          {error || "ARCHITECTURE · DATABASE · AUTH · UI · LOGIC · BUILD · DEPLOY"}
        </span>
        <button className="cr-build-button" disabled={busy || prompt.trim().length < 10} onClick={create}>
          {busy ? "CREATING…" : "BUILD THE APP"}<span>↗</span>
        </button>
      </div>
    </div>
  );
}
