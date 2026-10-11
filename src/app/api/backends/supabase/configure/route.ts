import { createHash } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validateGeneratedMigration } from "@/lib/supabase/generated-migration-safety";
import {
  createDevelopmentBranch,
  deleteDevelopmentBranch,
  getDevelopmentBranch,
  getSecurityAdvisor,
  mergeDevelopmentBranch,
  runDatabaseQuery,
  runReadOnlyDatabaseQuery,
  securityFindings,
  waitForProjectHealthy,
} from "@/lib/supabase/management";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });
const ACTIVE_RUN_STATUSES = new Set(["creating", "applying", "validating", "merging"]);
const STALE_RUN_MS = 5 * 60 * 1000;
const MERGE_VERIFY_TIMEOUT_MS = 180_000;

type MigrationFile = {
  path: string;
  content: string;
  contentHash: string;
};

export async function POST(request: Request) {
  const supabase = await createClient();
  let backendId: string | null = null;
  let schemaRunId: string | null = null;
  let branchRef: string | null = null;
  let trackingIds: string[] = [];
  let merged = false;

  try {
    const { projectId } = requestSchema.parse(await request.json());
    const { data: authData } = await supabase.auth.getUser();
    const user = authData.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,current_version_id")
      .eq("id", projectId)
      .single();
    if (projectError || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.current_version_id) return NextResponse.json({ error: "Generate the application before configuring its backend" }, { status: 409 });

    const { data: backend, error: backendError } = await supabase
      .from("app_backends")
      .select("id,status,external_project_ref,schema_version_id")
      .eq("project_id", projectId)
      .single();
    if (backendError || !backend?.external_project_ref) return NextResponse.json({ error: "Provision the app backend first" }, { status: 409 });
    backendId = backend.id;

    const migrations = await loadMigrations(supabase, project.current_version_id);
    const pending = await pendingMigrations(supabase, backend.id, migrations);

    if (pending.length === 0) {
      const { error: noChangeError } = await supabase
        .from("app_backends")
        .update({ status: "ready", schema_version_id: project.current_version_id, error_message: null })
        .eq("id", backend.id);
      if (noChangeError) throw new Error(noChangeError.message);
      return NextResponse.json({ configured: true, appliedMigrations: 0, securityFindings: 0, strategy: "no-schema-change" });
    }

    const mode = backend.schema_version_id ? "evolution" : "initial";
    pending.forEach((migration) => validateGeneratedMigration(migration.content, mode));

    const branchName = schemaBranchName(project.current_version_id);
    const { data: existingRun } = await supabase
      .from("backend_schema_runs")
      .select("id,status,branch_ref,updated_at")
      .eq("app_backend_id", backend.id)
      .eq("source_version_id", project.current_version_id)
      .maybeSingle();

    if (existingRun && ACTIVE_RUN_STATUSES.has(existingRun.status) && !isOlderThan(existingRun.updated_at, STALE_RUN_MS)) {
      return NextResponse.json({ inProgress: true, status: existingRun.status }, { status: 202 });
    }

    if (existingRun?.branch_ref) {
      await deleteBranchBestEffort(existingRun.branch_ref);
    } else {
      const staleByName = await findBranchBestEffort(backend.external_project_ref, branchName);
      const staleRef = staleByName?.project_ref || staleByName?.id;
      if (staleRef) await deleteBranchBestEffort(staleRef);
    }

    const { data: schemaRun, error: schemaRunError } = await supabase
      .from("backend_schema_runs")
      .upsert({
        app_backend_id: backend.id,
        project_id: projectId,
        source_version_id: project.current_version_id,
        user_id: user.id,
        branch_name: branchName,
        branch_ref: null,
        status: "creating",
        error_message: null,
      }, { onConflict: "app_backend_id,source_version_id" })
      .select("id")
      .single();
    if (schemaRunError || !schemaRun) throw new Error(schemaRunError?.message || "Could not create schema-run record");
    schemaRunId = schemaRun.id;

    await supabase.from("app_backends").update({ status: "configuring", error_message: null }).eq("id", backend.id);
    trackingIds = await prepareMigrationTracking(supabase, {
      backendId: backend.id,
      projectId,
      versionId: project.current_version_id,
      userId: user.id,
      migrations: pending,
    });

    const branch = await createDevelopmentBranch(backend.external_project_ref, branchName);
    branchRef = branch.project_ref || branch.id || null;
    if (!branchRef) throw new Error("Supabase DEV branch response did not include a branch ref");

    await supabase.from("backend_schema_runs").update({ branch_ref: branchRef, status: "creating" }).eq("id", schemaRunId);
    await waitForProjectHealthy(branchRef);

    await supabase.from("backend_schema_runs").update({ status: "applying" }).eq("id", schemaRunId);
    await runDatabaseQuery(branchRef, atomicMigrationSql(pending, project.current_version_id));

    await supabase.from("backend_schema_runs").update({ status: "validating" }).eq("id", schemaRunId);
    const branchAdvisor = await getSecurityAdvisor(branchRef);
    const branchFindings = securityFindings(branchAdvisor);
    if (branchFindings.length > 0) {
      throw new Error(`DEV branch security advisor reported ${branchFindings.length} finding${branchFindings.length === 1 ? "" : "s"}`);
    }

    await supabase.from("backend_schema_runs").update({ status: "merging" }).eq("id", schemaRunId);
    await mergeDevelopmentBranch(branchRef);
    await waitForSchemaMarker(backend.external_project_ref, project.current_version_id, MERGE_VERIFY_TIMEOUT_MS);
    merged = true;

    const productionAdvisor = await getSecurityAdvisor(backend.external_project_ref);
    const productionFindings = securityFindings(productionAdvisor);
    if (productionFindings.length > 0) {
      throw new Error(`Production security advisor reported ${productionFindings.length} finding${productionFindings.length === 1 ? "" : "s"} after DEV merge`);
    }

    await markMigrations(supabase, trackingIds, "applied");
    const { error: readyError } = await supabase
      .from("app_backends")
      .update({ status: "ready", schema_version_id: project.current_version_id, error_message: null })
      .eq("id", backend.id);
    if (readyError) throw new Error(readyError.message);

    await supabase.from("backend_schema_runs").update({ status: "merged", error_message: null }).eq("id", schemaRunId);

    let cleanupWarning: string | null = null;
    try {
      await deleteDevelopmentBranch(branchRef);
      branchRef = null;
    } catch (cleanupError) {
      cleanupWarning = cleanupError instanceof Error ? cleanupError.message : "DEV branch cleanup failed";
      await supabase.from("backend_schema_runs").update({ status: "cleanup_failed", error_message: clip(cleanupWarning) }).eq("id", schemaRunId);
    }

    return NextResponse.json({
      configured: true,
      appliedMigrations: pending.length,
      securityFindings: 0,
      strategy: "dev-branch",
      mode,
      cleanupWarning,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backend configuration failed";
    if (trackingIds.length > 0 && !merged) await markMigrations(supabase, trackingIds, "failed", message);
    if (schemaRunId) await supabase.from("backend_schema_runs").update({ status: "failed", error_message: clip(message) }).eq("id", schemaRunId);
    if (backendId) await supabase.from("app_backends").update({ status: "failed", error_message: clip(message) }).eq("id", backendId);
    if (branchRef && !merged) await deleteBranchBestEffort(branchRef);
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid backend request" }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

async function loadMigrations(supabase: Awaited<ReturnType<typeof createClient>>, versionId: string): Promise<MigrationFile[]> {
  const { data, error } = await supabase
    .from("generated_files")
    .select("path,content,content_hash")
    .eq("version_id", versionId)
    .like("path", "supabase/migrations/%.sql")
    .order("path", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((file) => ({
    path: file.path,
    content: file.content,
    contentHash: file.content_hash || createHash("sha256").update(file.content, "utf8").digest("hex"),
  }));
}

async function pendingMigrations(
  supabase: Awaited<ReturnType<typeof createClient>>,
  backendId: string,
  migrations: MigrationFile[],
) {
  const { data, error } = await supabase
    .from("backend_migrations")
    .select("content_hash")
    .eq("app_backend_id", backendId)
    .eq("status", "applied");
  if (error) throw new Error(error.message);
  const applied = new Set((data || []).map((row) => row.content_hash));
  return migrations.filter((migration) => !applied.has(migration.contentHash));
}

async function prepareMigrationTracking(
  supabase: Awaited<ReturnType<typeof createClient>>,
  options: { backendId: string; projectId: string; versionId: string; userId: string; migrations: MigrationFile[] },
) {
  const ids: string[] = [];
  for (const migration of options.migrations) {
    const { data, error } = await supabase
      .from("backend_migrations")
      .upsert({
        app_backend_id: options.backendId,
        project_id: options.projectId,
        source_version_id: options.versionId,
        user_id: options.userId,
        path: migration.path,
        content_hash: migration.contentHash,
        migration_name: migrationLabel(options.versionId, migration.path),
        status: "applying",
        error_message: null,
      }, { onConflict: "app_backend_id,content_hash" })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message || "Could not track backend migration");
    ids.push(data.id);
  }
  return ids;
}

async function markMigrations(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
  status: "applied" | "failed",
  errorMessage?: string,
) {
  if (ids.length === 0) return;
  const patch = status === "applied"
    ? { status, applied_at: new Date().toISOString(), error_message: null }
    : { status, error_message: clip(errorMessage || "Schema deployment failed") };
  const { error } = await supabase.from("backend_migrations").update(patch).in("id", ids);
  if (error) console.warn("Migration tracking update failed:", error.message);
}

function atomicMigrationSql(migrations: MigrationFile[], versionId: string) {
  const statements = migrations.map((migration) => migration.content.trim().replace(/;+\s*$/, ""));
  return ["begin", ...statements, schemaMarkerSql(versionId), "commit"].join(";\n\n") + ";";
}

function schemaMarkerSql(versionId: string) {
  const table = schemaMarkerTable(versionId);
  return [
    "create schema if not exists lymtless_internal",
    "revoke all on schema lymtless_internal from public, anon, authenticated",
    `create table if not exists lymtless_internal.${table} (created_at timestamptz not null default now())`,
    `revoke all on table lymtless_internal.${table} from public, anon, authenticated`,
  ].join(";\n");
}

async function waitForSchemaMarker(productionRef: string, versionId: string, timeoutMs: number) {
  const table = schemaMarkerTable(versionId);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await runReadOnlyDatabaseQuery<unknown>(
      productionRef,
      `select to_regclass('lymtless_internal.${table}') is not null as marker_present`,
    );
    if (containsMarker(response)) return;
    await sleep(2500);
  }
  throw new Error("Timed out waiting for the DEV branch schema merge to reach production");
}

function containsMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMarker);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.marker_present === true) return true;
  return Object.values(record).some(containsMarker);
}

function schemaMarkerTable(versionId: string) {
  return `v_${versionId.replace(/-/g, "").toLowerCase()}`;
}

function schemaBranchName(versionId: string) {
  return `lymtless-${versionId.replace(/-/g, "").slice(0, 12).toLowerCase()}`;
}

async function findBranchBestEffort(parentRef: string, branchName: string) {
  try {
    return await getDevelopmentBranch(parentRef, branchName);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/Management API 404:/.test(message)) return null;
    throw error;
  }
}

async function deleteBranchBestEffort(branchRefOrId: string) {
  try {
    await deleteDevelopmentBranch(branchRefOrId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/Management API 404:/.test(message)) console.warn("DEV branch cleanup failed:", message);
  }
}

function isOlderThan(timestamp: unknown, ageMs: number) {
  if (typeof timestamp !== "string") return false;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && Date.now() - value >= ageMs;
}

function migrationLabel(versionId: string, migrationPath: string) {
  const base = path.posix.basename(migrationPath, ".sql").replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `lymtless_${versionId.slice(0, 8)}_${base}`.slice(0, 120);
}

function clip(value: string) {
  return value.length > 10_000 ? `${value.slice(0, 10_000)}…` : value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
