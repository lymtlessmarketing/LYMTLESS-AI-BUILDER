"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type GithubStatus = {
  connected: boolean;
  githubLogin: string | null;
  installationId: number | null;
  repoFullName: string | null;
  branch: string | null;
  lastSyncedSha: string | null;
  syncStatus: string;
  syncError: string | null;
};

export function GithubControls({ projectId, versionId }: { projectId: string; versionId?: string | null }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const autoSyncedVersion = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/github/status?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
    if (!response.ok) return;
    setStatus(await response.json() as GithubStatus);
  }, [projectId]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError("");
    try {
      const response = await fetch("/api/github/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "GitHub sync failed");
      await refresh();
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "GitHub sync failed");
      throw e;
    } finally {
      setSyncing(false);
    }
  }, [projectId, refresh]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!versionId || !status?.connected || autoSyncedVersion.current === versionId) return;
    autoSyncedVersion.current = versionId;
    const timer = window.setTimeout(() => { void sync().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, [status?.connected, sync, versionId]);

  if (!status?.connected) {
    return (
      <a className="secondary-btn" href={`/api/github/connect?projectId=${encodeURIComponent(projectId)}`} title={error || undefined}>
        Connect GitHub
      </a>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }} title={error || status.syncError || undefined}>
      {status.repoFullName ? (
        <a className="secondary-btn" href={`https://github.com/${status.repoFullName}`} target="_blank" rel="noreferrer">
          Open Repo
        </a>
      ) : null}
      <button className="secondary-btn" type="button" disabled={syncing} onClick={() => void sync()}>
        {syncing ? "Syncing…" : status.repoFullName ? "Sync GitHub" : "Create GitHub Repo"}
      </button>
    </div>
  );
}