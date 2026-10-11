"use client";

import { useCallback, useEffect, useState } from "react";

type DomainRecord = {
  id: string;
  domain: string;
  status: string;
  verified: boolean;
  verification: unknown;
  dns_config: unknown;
  error_message?: string | null;
};

type DeployStatus = {
  productionUrl: string | null;
  currentVersion: { id: string; status: string; version_number: number } | null;
  latestDeployment: { status: string; url?: string | null } | null;
  domains: DomainRecord[];
};

type DomainResponse = {
  domain: DomainRecord;
  instructions: {
    status: string;
    records: Array<{ type: string; name: string; value: string; purpose: string }>;
  };
};

export function DeploymentControls({ projectId, ready }: { projectId: string; ready: boolean }) {
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [domain, setDomain] = useState("");
  const [domainBusy, setDomainBusy] = useState(false);
  const [domainResult, setDomainResult] = useState<DomainResponse | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/deploy/status?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
    if (!response.ok) return;
    setStatus(await response.json() as DeployStatus);
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const persistedReady = status?.currentVersion && ["tested", "deployed"].includes(status.currentVersion.status);
  const canPublish = ready || Boolean(persistedReady);

  async function publish() {
    setPublishing(true);
    setError("");
    try {
      const response = await fetch("/api/deploy/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Production deployment failed");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Production deployment failed");
    } finally {
      setPublishing(false);
    }
  }

  async function attachDomain() {
    const value = domain.trim().toLowerCase();
    if (!value) return;
    setDomainBusy(true);
    setError("");
    try {
      const response = await fetch("/api/deploy/domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, domain: value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Custom domain setup failed");
      setDomainResult(data as DomainResponse);
      setDomain("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Custom domain setup failed");
    } finally {
      setDomainBusy(false);
    }
  }

  async function refreshDomain(value: string) {
    setDomainBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/deploy/domain?projectId=${encodeURIComponent(projectId)}&domain=${encodeURIComponent(value)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not refresh domain status");
      setDomainResult(data as DomainResponse);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh domain status");
    } finally {
      setDomainBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", position: "relative" }} title={error || undefined}>
      {status?.productionUrl ? (
        <a className="secondary-btn" href={status.productionUrl} target="_blank" rel="noreferrer">Live Site</a>
      ) : null}
      <button className="primary-btn" type="button" disabled={!canPublish || publishing} onClick={() => void publish()}>
        {publishing ? "Publishing…" : status?.productionUrl ? "Republish" : "Publish"}
      </button>
      {status?.productionUrl ? (
        <details style={{ position: "relative" }}>
          <summary className="secondary-btn" style={{ listStyle: "none", cursor: "pointer" }}>Domains</summary>
          <div style={{ position: "absolute", right: 0, top: 40, width: 390, padding: 14, zIndex: 40, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "0 20px 55px rgba(0,0,0,.22)", display: "grid", gap: 10 }}>
            <strong>Custom Domain</strong>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="app.example.com" style={{ flex: 1 }} />
              <button className="primary-btn" type="button" disabled={domainBusy || domain.trim().length < 3} onClick={() => void attachDomain()}>{domainBusy ? "Checking…" : "Add"}</button>
            </div>
            {(status.domains || []).map((item) => (
              <div key={item.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 8, display: "grid", gap: 5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><strong>{item.domain}</strong><span className="badge">{item.status}</span></div>
                {item.status !== "ready" ? <button className="secondary-btn" type="button" disabled={domainBusy} onClick={() => void refreshDomain(item.domain)}>Refresh DNS</button> : null}
              </div>
            ))}
            {domainResult?.instructions.records?.length ? (
              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                <strong>DNS records needed</strong>
                {domainResult.instructions.records.map((record, index) => (
                  <div key={`${record.type}-${record.name}-${index}`} style={{ marginTop: 7, fontSize: 12 }}>
                    <code>{record.type} {record.name} → {record.value}</code><div className="status">{record.purpose}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {error ? <div className="status error">{error}</div> : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
