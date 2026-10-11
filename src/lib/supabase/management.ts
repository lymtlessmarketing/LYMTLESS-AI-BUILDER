const MANAGEMENT_API = "https://api.supabase.com";
const MAX_ATTEMPTS = 4;

export type PlatformProject = {
  id?: string;
  ref?: string;
  name?: string;
  region?: string;
  status?: string;
};

export type DatabaseBranch = {
  id?: string;
  name: string;
  project_ref: string;
  parent_project_ref?: string;
  persistent?: boolean;
  with_data?: boolean;
  status?: string;
  preview_project_status?: string;
};

type ActionRun = {
  id?: string;
  failure?: unknown;
  run_steps?: Array<{ name?: string; status?: string }>;
  steps?: Array<{ name?: string; status?: string }>;
};

type OrganizationProjectsResponse = {
  projects?: PlatformProject[];
  pagination?: { count?: number; limit?: number; offset?: number };
};

type ApiKeyRecord = {
  id?: string;
  type?: string;
  name?: string;
  api_key?: string;
  disabled?: boolean;
};

export function managementConfigured() {
  return Boolean(process.env.SUPABASE_MANAGEMENT_TOKEN && process.env.SUPABASE_PLATFORM_ORG_SLUG);
}

export function platformOrganizationSlug() {
  const value = process.env.SUPABASE_PLATFORM_ORG_SLUG;
  if (!value) throw new Error("SUPABASE_PLATFORM_ORG_SLUG is not configured");
  return value;
}

export async function findPlatformProjectByName(name: string) {
  const slug = encodeURIComponent(platformOrganizationSlug());
  const params = new URLSearchParams({ limit: "20", offset: "0", search: name });
  const response = await managementRequest<OrganizationProjectsResponse>(`/v1/organizations/${slug}/projects?${params.toString()}`);
  return (response.projects || []).find((project) => project.name === name) || null;
}

export async function createPlatformProject(options: { name: string; dbPassword: string }) {
  const smartRegion = process.env.SUPABASE_SMART_REGION || "americas";
  return managementRequest<PlatformProject>("/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      name: options.name,
      organization_slug: platformOrganizationSlug(),
      db_pass: options.dbPassword,
      region_selection: { type: "smartGroup", code: smartRegion },
    }),
  });
}

export async function waitForProjectHealthy(ref: string, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await managementRequest<unknown>(`/v1/projects/${encodeURIComponent(ref)}/health`);
    if (healthIsReady(health)) return health;
    await sleep(2500);
  }
  throw new Error(`Supabase project ${ref} did not become healthy before timeout`);
}

export async function createDatabaseBranch(parentRef: string, branchName: string) {
  return managementRequest<DatabaseBranch>(`/v1/projects/${encodeURIComponent(parentRef)}/branches`, {
    method: "POST",
    body: JSON.stringify({
      branch_name: branchName,
      persistent: false,
      with_data: false,
      is_default: false,
    }),
  });
}

export async function getDatabaseBranch(parentRef: string, branchName: string) {
  return managementRequest<DatabaseBranch>(
    `/v1/projects/${encodeURIComponent(parentRef)}/branches/${encodeURIComponent(branchName)}`,
  );
}

export async function waitForDatabaseBranch(parentRef: string, branchName: string, timeoutMs = 180_000) {
  const started = Date.now();
  let last: DatabaseBranch | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await getDatabaseBranch(parentRef, branchName);
    if (last.project_ref) {
      try {
        await waitForProjectHealthy(last.project_ref, 15_000);
        return last;
      } catch {
        // Branch exists but its services may still be provisioning.
      }
    }
    const status = `${last.status || ""} ${last.preview_project_status || ""}`.toUpperCase();
    if (/(FAILED|ERROR|DELETED)/.test(status)) {
      throw new Error(`Supabase branch ${branchName} failed to provision (${status.trim()})`);
    }
    await sleep(2500);
  }
  throw new Error(`Supabase branch ${branchName} did not become healthy before timeout${last?.status ? ` (${last.status})` : ""}`);
}

export async function mergeDatabaseBranch(branchRef: string) {
  return managementRequest<{ workflow_run_id?: string; message?: string }>(
    `/v1/branches/${encodeURIComponent(branchRef)}/merge`,
    { method: "POST", body: "{}" },
  );
}

export async function scheduleDatabaseBranchDeletion(branchRef: string) {
  return managementRequest<{ message?: string }>(
    `/v1/branches/${encodeURIComponent(branchRef)}?force=false`,
    { method: "DELETE" },
  );
}

export async function forceDeleteDatabaseBranch(branchRef: string) {
  return managementRequest<{ message?: string }>(
    `/v1/branches/${encodeURIComponent(branchRef)}?force=true`,
    { method: "DELETE" },
  );
}

export async function getActionRun(parentRef: string, runId: string) {
  return managementRequest<ActionRun>(
    `/v1/projects/${encodeURIComponent(parentRef)}/actions/${encodeURIComponent(runId)}`,
  );
}

export async function waitForActionRun(parentRef: string, runId: string, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await getActionRun(parentRef, runId);
    const steps = run.run_steps || run.steps || [];
    if (run.failure) throw new Error(`Supabase action ${runId} failed: ${stringifyFailure(run.failure)}`);
    if (steps.length > 0) {
      const statuses = steps.map((step) => (step.status || "").toLowerCase());
      if (statuses.some((status) => ["failed", "failure", "cancelled", "canceled", "error"].includes(status))) {
        throw new Error(`Supabase action ${runId} failed (${statuses.join(", ")})`);
      }
      if (statuses.every((status) => ["exited", "completed", "success", "succeeded", "skipped"].includes(status))) {
        return run;
      }
    }
    await sleep(2000);
  }
  throw new Error(`Supabase action ${runId} did not complete before timeout`);
}

export async function ensurePublishableKey(ref: string) {
  const path = `/v1/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`;
  let keys = await managementRequest<ApiKeyRecord[]>(path);
  let publishable = keys.find((key) => key.type === "publishable" && !key.disabled && key.api_key);

  if (!publishable) {
    await managementRequest<ApiKeyRecord>(path, {
      method: "POST",
      body: JSON.stringify({ type: "publishable", name: "lymtless-default" }),
    });
    keys = await managementRequest<ApiKeyRecord[]>(path);
    publishable = keys.find((key) => key.type === "publishable" && !key.disabled && key.api_key);
  }

  if (!publishable?.api_key) throw new Error(`Supabase project ${ref} has no usable publishable API key`);
  return publishable.api_key;
}

export async function runDatabaseQuery(ref: string, query: string) {
  return managementRequest<unknown>(`/v1/projects/${encodeURIComponent(ref)}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query, read_only: false }),
  });
}

export async function getSecurityAdvisor(ref: string) {
  return managementRequest<unknown>(`/v1/projects/${encodeURIComponent(ref)}/advisors/security`);
}

export function securityFindings(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.lints)) return record.lints;
  if (record.result && typeof record.result === "object") {
    const result = record.result as Record<string, unknown>;
    if (Array.isArray(result.lints)) return result.lints;
  }
  return [];
}

async function managementRequest<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (!token) throw new Error("SUPABASE_MANAGEMENT_TOKEN is not configured");

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${MANAGEMENT_API}${pathname}`, {
        ...init,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(init.headers || {}),
        },
      });

      const text = await response.text();
      const payload = text ? safeJson(text) : null;
      if (response.ok) return payload as T;

      const detail = extractError(payload) || text || response.statusText;
      const error = new Error(`Supabase Management API ${response.status}: ${detail}`);
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;

      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await sleep(Math.min(delay, 10_000));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Supabase Management API request failed");
      if (attempt === MAX_ATTEMPTS - 1 || /Management API 4\d\d:/.test(lastError.message)) break;
      await sleep(500 * 2 ** attempt);
    }
  }

  throw lastError || new Error("Supabase Management API request failed");
}

function healthIsReady(payload: unknown) {
  const services: Array<{ healthy: boolean; status: string }> = [];
  collectHealthServices(payload, services);
  return services.length > 0 && services.every((service) => service.healthy && service.status === "ACTIVE_HEALTHY");
}

function collectHealthServices(value: unknown, services: Array<{ healthy: boolean; status: string }>) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectHealthServices(item, services));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.healthy === "boolean" && typeof record.status === "string") {
    services.push({ healthy: record.healthy, status: record.status });
  }
  Object.values(record).forEach((item) => collectHealthServices(item, services));
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractError(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["message", "error", "msg", "detail"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

function stringifyFailure(value: unknown) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return "unknown failure"; }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
