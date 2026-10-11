import { createHash } from "node:crypto";

const API = "https://api.vercel.com";
const MAX_SOURCE_BYTES = 2_000_000;

export type DeploymentFile = { path: string; content: string };
export type VercelProject = { id: string; name: string };
export type VercelDeployment = {
  id: string;
  url?: string;
  readyState?: string;
  target?: string | null;
  alias?: string[];
  errorCode?: string;
  errorMessage?: string;
};

type VercelDomain = {
  name: string;
  verified?: boolean;
  verification?: Array<{ type?: string; domain?: string; value?: string; reason?: string }>;
};

export function vercelPlatformConfigured() {
  return Boolean(process.env.VERCEL_TOKEN);
}

export async function createHostingProject(name: string, env: Record<string, string>) {
  const body: Record<string, unknown> = {
    name,
    framework: null,
    buildCommand: "npm run build",
    installCommand: "npm install",
    outputDirectory: "dist",
    skipGitConnectDuringLink: true,
  };
  if (Object.keys(env).length) {
    body.environmentVariables = Object.entries(env).map(([key, value]) => ({
      key,
      value,
      type: "plain",
      target: "production",
    }));
  }
  return request<VercelProject>("/v11/projects", { method: "POST", body: JSON.stringify(body) });
}

export async function uploadDeploymentFiles(files: DeploymentFile[]) {
  const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  if (total > MAX_SOURCE_BYTES) throw new Error("Production source bundle exceeds the 2 MB deployment limit");

  const uploaded: Array<{ file: string; sha: string; size: number }> = [];
  for (const file of files) {
    const bytes = Buffer.from(file.content, "utf8");
    const sha = createHash("sha1").update(bytes).digest("hex");
    await requestRaw("/v2/files", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
        "x-vercel-digest": sha,
      },
      body: bytes,
    });
    uploaded.push({ file: file.path, sha, size: bytes.length });
  }
  return uploaded;
}

export async function createProductionDeployment(options: {
  project: VercelProject;
  files: Array<{ file: string; sha: string; size: number }>;
}) {
  return request<VercelDeployment>("/v13/deployments?skipAutoDetectionConfirmation=1", {
    method: "POST",
    body: JSON.stringify({
      name: options.project.name,
      project: options.project.id,
      files: options.files,
      target: "production",
      projectSettings: {
        framework: null,
        buildCommand: "npm run build",
        installCommand: "npm install",
        outputDirectory: "dist",
        nodeVersion: "24.x",
      },
      meta: { source: "lymtless-ai-builder" },
    }),
  });
}

export async function waitForDeployment(id: string, timeoutMs = 300_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const deployment = await request<VercelDeployment>(`/v13/deployments/${encodeURIComponent(id)}`);
    const state = String(deployment.readyState || "").toUpperCase();
    if (state === "READY") return deployment;
    if (["ERROR", "CANCELED", "CANCELLED"].includes(state)) {
      throw new Error(deployment.errorMessage || deployment.errorCode || `Vercel deployment ${id} failed (${state})`);
    }
    await sleep(2500);
  }
  throw new Error(`Vercel deployment ${id} did not become READY before timeout`);
}

export async function addProjectDomain(projectId: string, domain: string) {
  return request<VercelDomain>(`/v10/projects/${encodeURIComponent(projectId)}/domains`, {
    method: "POST",
    body: JSON.stringify({ name: domain }),
  });
}

export async function getProjectDomain(projectId: string, domain: string) {
  return request<VercelDomain>(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`);
}

export async function verifyProjectDomain(projectId: string, domain: string) {
  return request<VercelDomain>(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}/verify`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function getDomainConfig(domain: string) {
  return request<Record<string, unknown>>(`/v6/domains/${encodeURIComponent(domain)}/config`);
}

async function request<T>(pathname: string, init: RequestInit = {}) {
  const response = await apiFetch(pathname, init);
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok) throw new Error(`Vercel API ${response.status}: ${extractError(payload) || text || response.statusText}`);
  return payload as T;
}

async function requestRaw(pathname: string, init: RequestInit = {}) {
  const response = await apiFetch(pathname, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vercel API ${response.status}: ${extractError(safeJson(text)) || text || response.statusText}`);
  }
}

async function apiFetch(pathname: string, init: RequestInit) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is not configured for production deployments");
  const teamId = process.env.VERCEL_TEAM_ID;
  const url = new URL(`${API}${pathname}`);
  if (teamId && !url.searchParams.has("teamId")) url.searchParams.set("teamId", teamId);
  return fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function extractError(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
  }
  if (typeof record.message === "string") return record.message;
  return "";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
