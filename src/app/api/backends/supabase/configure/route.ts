import { createHash } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validateGeneratedMigration } from "@/lib/supabase/generated-migration-safety";
import {
  deleteDatabaseBranch,
  diffDatabaseBranch,
  ensureDatabaseBranch,
  getSecurityAdvisor,
  hasSchemaDiff,
  mergeDatabaseBranch,
  runDatabaseQuery,
  securityFindings,
  waitForActionRun,
  waitForDatabaseBranch,
  waitForProjectHealthy,
} from "@/lib/supabase/management";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });
const ACTIVE_SCHEMA_RUN_STATUSES = new Set(["creating", "applying", "validating", "merging"]);

type Migration = {
  path: string;
  content: string;
  contentHash: string;
};

type SchemaRunRecord = {
  id: string;
  status: string;
  branch_ref: string | null;
  branch_project_ref: string | null;
};

export async function POST(request: Request) {
  const supabase = await createClient();
  let backendId: string | null = null;
  let schemaRunId: string | null = null;
  let sourceVersionId: string | null = null;

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
    sourceVersionId = project.current_version_id;

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
      const { error: readyError } = await supabase
        .from("app_backends")
        .update({ status: "ready", schema_version_id: project.current_version_id, error_message: null })
        .eq("id", backend.id);
      if (readyError) throw new Error(readyError.message);
      return NextResponse.json({ configured: true, appliedMigrations: 0, securityFindings: 0, reused: true });
    }

    const safetyMode = backend.schema_version_id ? "evolution" : "initial";
    pending.forEach((migration) => validateGeneratedMigration(migration.content, { mode: safetyMode }));
    await supabase.from("app_backends").update({ status: "configuring", error_message: null }).eq("id", backend.id);

    if (!backend.schema_version_id) {
      await applyInitialSchema({ supabase, backend, projectId, userId: user.id, sourceVersionId: project.current_version_id, pending });
      return NextResponse.json({ configured: true, appliedMigrations: pending.length, securityFindings: 0, schemaEvolution: "initial" });
    }

    const result = await evolveSchemaOnBranch({
      supabase,
      backend,
      projectId,
      userId: user.id,
      sourceVersionId: project.current_version_id,
      pending,
      setSchemaRunId: (value) => { schemaRunId = value; },
    });

    return NextResponse.json({
      configured: true,
      appliedMigrations: pending.length,
      securityFindings: 0,
      schemaEvolution: "preview_branch",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backend configuration failed";
    if (schemaRunId) {
      await supabase.from("backend_schema_runs").update({ status: "failed", error_message: clip(message) }).eq("id", schemaRunId);
    }
    if (backendId) {
      await supabase.from("app_backends").update({ status: "failed", error_message: clip(message) }).eq("id", backendId);
      if (sourceVersionId) {
        await supabase
          .from("backend_migrations")
          .update({ status: "failed", error_message: clip(message) })
          .eq("app_backend_id", backendId)
          .eq("source_version_id", sourceVersionId)
          .eq("status", "applying");
      }
    }
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid backend request" }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

async function loadMigrations(supabase: Awaited<ReturnType<typeof createClient>>, versionId: string): Promise<Migration[]> {
  const { data: migrationFiles, error: filesError } = await supabase
    .from("generated_files")
    .select("path,content,content_hash")
    .eq("version_id", versionId)
    .like("path", "supabase/migrations/%.sql")
    .order("path", { ascending: true });
  if (filesError) throw new Error(filesError.message);

  return (migrationFiles || []).map((file) => ({
    path: file.path,
    content: file.content,
    contentHash: file.content_hash || createHash("sha256").update(file.content, "utf8").digest("hex"),
  }));
}

async function pendingMigrations(
  supabase: Awaited<ReturnType<typeof createClient>>,
  backendId: string,
  migrations: Migration[],
) {
  const { data: appliedRows, error: appliedError } = await supabase
    .from("backend_migrations")
    .select("content_hash")
    .eq("app_backend_id", backendId)
    .eq("status", "applied");
  if (appliedError) throw new Error(appliedError.message);
  const applied = new Set((appliedRows || []).map((row) => row.content_hash));
  return migrations.filter((migration) => !applied.has(migration.contentHash));
}

async function applyInitialSchema(options: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  backend: { id: string; external_project_ref: string; schema_version_id: string | null };
  projectId: string;
  userId: string;
  sourceVersionId: string;
  pending: Migration[];
}) {
  for (const migration of options.pending) {
    const trackingId = await trackMigration(options, migration);
    try {
      await runDatabaseQuery(options.backend.external_project_ref, migration.content);
      await options.supabase
        .from("backend_migrations")
        .update({ status: "applied", applied_at: new Date().toISOString(), error_message: null })
        .eq("id", trackingId);
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : "Database migration failed";
      await options.supabase.from("backend_migrations").update({ status: "failed", error_message: clip(message) }).eq("id", trackingId);
      throw migrationError;
    }
  }

  const findings = securityFindings(await getSecurityAdvisor(options.backend.external_project_ref));
  if (findings.length > 0) throw new Error(`Supabase security advisor reported ${findings.length} finding${findings.length === 1 ? "" : "s"} after schema configuration`);

  const { error: readyError } = await options.supabase
    .from("app_backends")
    .update({ status: "ready", schema_version_id: options.sourceVersionId, error_message: null })
    .eq("id", options.backend.id);
  if (readyError) throw new Error(readyError.message);
}

async function evolveSchemaOnBranch(options: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  backend: { id: string; external_project_ref: string; schema_version_id: string | null };
  projectId: string;
  userId: string;
  sourceVersionId: string;
  pending: Migration[];
  setSchemaRunId: (value: string) => void;
}) {
  const branchName = schemaBranchName(options.projectId, options.sourceVersionId);
  const schemaRun = await claimSchemaRun({ ...options, branchName });
  options.setSchemaRunId(schemaRun.id);

  if (schemaRun.branch_project_ref || schemaRun.branch_ref) {
    await removeBranchIfPresent(schemaRun.branch_project_ref || schemaRun.branch_ref!);
  }

  await ensureDatabaseBranch(options.backend.external_project_ref, branchName);
  const branch = await waitForDatabaseBranch(options.backend.external_project_ref, branchName);
  const branchProjectRef = branch.project_ref;
  const mergeRef = branch.project_ref || branch.id;
  if (!branchProjectRef || !mergeRef) throw new Error("Supabase branch did not return a usable project ref");

  await options.supabase.from("backend_schema_runs").update({
    branch_ref: branch.id || mergeRef,
    branch_project_ref: branchProjectRef,
    status: "applying",
    validation_log: "Preview branch is healthy; applying generated migrations.",
  }).eq("id", schemaRun.id);

  for (const migration of options.pending) {
    await trackMigration(options, migration);
    await runDatabaseQuery(branchProjectRef, migration.content);
  }

  await options.supabase.from("backend_schema_runs").update({ status: "validating" }).eq("id", schemaRun.id);
  const branchFindings = securityFindings(await getSecurityAdvisor(branchProjectRef));
  if (branchFindings.length > 0) {
    await options.supabase.from("backend_schema_runs").update({ security_findings: boundedJson(branchFindings) }).eq("id", schemaRun.id);
    throw new Error(`Supabase preview branch security advisor reported ${branchFindings.length} finding${branchFindings.length === 1 ? "" : "s"}`);
  }

  const diff = await diffDatabaseBranch(mergeRef);
  await options.supabase.from("backend_schema_runs").update({
    diff_payload: boundedJson(diff),
    security_findings: [],
    validation_log: "Generated migrations applied successfully; security advisor passed and schema diff was reviewed by the branch gate.",
  }).eq("id", schemaRun.id);

  if (!hasSchemaDiff(diff)) {
    await finalizeAppliedVersion(options);
    await options.supabase.from("backend_schema_runs").update({
      status: "merged",
      merged_at: new Date().toISOString(),
      validation_log: "Preview branch passed validation but produced no production schema diff; version accepted without merge.",
    }).eq("id", schemaRun.id);
    await cleanupBranch(options.supabase, schemaRun.id, mergeRef);
    return { branchName, merged: false, noSchemaDiff: true };
  }

  await options.supabase.from("backend_schema_runs").update({ status: "merging" }).eq("id", schemaRun.id);
  const merge = await mergeDatabaseBranch(mergeRef);
  if (!merge.workflow_run_id) throw new Error("Supabase merge did not return a deployment workflow id");
  await options.supabase.from("backend_schema_runs").update({ merge_workflow_run_id: merge.workflow_run_id }).eq("id", schemaRun.id);

  await waitForActionRun(options.backend.external_project_ref, merge.workflow_run_id);
  await waitForProjectHealthy(options.backend.external_project_ref, 120_000);

  const productionFindings = securityFindings(await getSecurityAdvisor(options.backend.external_project_ref));
  if (productionFindings.length > 0) {
    await options.supabase.from("backend_schema_runs").update({ security_findings: boundedJson(productionFindings) }).eq("id", schemaRun.id);
    throw new Error(`Production Supabase security advisor reported ${productionFindings.length} finding${productionFindings.length === 1 ? "" : "s"} after merge`);
  }

  await finalizeAppliedVersion(options);
  await options.supabase.from("backend_schema_runs").update({
    status: "merged",
    merged_at: new Date().toISOString(),
    security_findings: [],
    validation_log: "Preview branch migrations, security checks, diff gate, deployment workflow, and production security advisor all passed.",
    error_message: null,
  }).eq("id", schemaRun.id);

  await cleanupBranch(options.supabase, schemaRun.id, mergeRef);
  return { branchName, merged: true, workflowRunId: merge.workflow_run_id };
}

async function claimSchemaRun(options: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  backend: { id: string };
  projectId: string;
  userId: string;
  sourceVersionId: string;
  branchName: string;
}): Promise<SchemaRunRecord> {
  const payload = {
    app_backend_id: options.backend.id,
    project_id: options.projectId,
    source_version_id: options.sourceVersionId,
    user_id: options.userId,
    branch_name: options.branchName,
    status: "creating",
    error_message: null,
  };

  const { data: inserted, error: insertError } = await options.supabase
    .from("backend_schema_runs")
    .insert(payload)
    .select("id,status,branch_ref,branch_project_ref")
    .maybeSingle();
  if (inserted) return inserted as SchemaRunRecord;

  const { data: existing, error: existingError } = await options.supabase
    .from("backend_schema_runs")
    .select("id,status,branch_ref,branch_project_ref")
    .eq("app_backend_id", options.backend.id)
    .eq("source_version_id", options.sourceVersionId)
    .maybeSingle();
  if (existingError || !existing) throw new Error(insertError?.message || existingError?.message || "Could not claim schema evolution run");
  if (ACTIVE_SCHEMA_RUN_STATUSES.has(existing.status)) throw new Error("Schema evolution is already in progress for this application version");
  if (existing.status === "merged") throw new Error("Schema evolution is already marked merged but unapplied migration hashes remain");

  const { data: claimed, error: claimError } = await options.supabase
    .from("backend_schema_runs")
    .update({
      branch_name: options.branchName,
      branch_ref: null,
      branch_project_ref: null,
      status: "creating",
      error_message: null,
      validation_log: null,
      diff_payload: {},
      security_findings: [],
      merge_workflow_run_id: null,
      merged_at: null,
    })
    .eq("id", existing.id)
    .eq("status", existing.status)
    .select("id,status,branch_ref,branch_project_ref")
    .maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) throw new Error("Schema evolution was claimed by another request");

  return { ...(claimed as SchemaRunRecord), branch_ref: existing.branch_ref, branch_project_ref: existing.branch_project_ref };
}

async function trackMigration(
  options: {
    supabase: Awaited<ReturnType<typeof createClient>>;
    backend: { id: string };
    projectId: string;
    userId: string;
    sourceVersionId: string;
  },
  migration: Migration,
) {
  const { data: tracking, error: trackingError } = await options.supabase
    .from("backend_migrations")
    .upsert({
      app_backend_id: options.backend.id,
      project_id: options.projectId,
      source_version_id: options.sourceVersionId,
      user_id: options.userId,
      path: migration.path,
      content_hash: migration.contentHash,
      migration_name: migrationLabel(options.sourceVersionId, migration.path),
      status: "applying",
      error_message: null,
    }, { onConflict: "app_backend_id,content_hash" })
    .select("id")
    .single();
  if (trackingError || !tracking) throw new Error(trackingError?.message || "Could not track backend migration");
  return tracking.id as string;
}

async function finalizeAppliedVersion(options: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  backend: { id: string };
  sourceVersionId: string;
}) {
  const now = new Date().toISOString();
  const { error: migrationUpdateError } = await options.supabase
    .from("backend_migrations")
    .update({ status: "applied", applied_at: now, error_message: null })
    .eq("app_backend_id", options.backend.id)
    .eq("source_version_id", options.sourceVersionId)
    .eq("status", "applying");
  if (migrationUpdateError) throw new Error(migrationUpdateError.message);

  const { error: readyError } = await options.supabase
    .from("app_backends")
    .update({ status: "ready", schema_version_id: options.sourceVersionId, error_message: null })
    .eq("id", options.backend.id);
  if (readyError) throw new Error(readyError.message);
}

async function cleanupBranch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  schemaRunId: string,
  branchRef: string,
) {
  try {
    await deleteDatabaseBranch(branchRef);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Branch cleanup failed";
    if (/Management API 404:/.test(message)) return;
    await supabase.from("backend_schema_runs").update({ status: "cleanup_failed", error_message: clip(message) }).eq("id", schemaRunId);
  }
}

async function removeBranchIfPresent(branchRef: string) {
  try {
    await deleteDatabaseBranch(branchRef);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Branch cleanup failed";
    if (!/Management API 404:/.test(message)) throw error;
  }
}

function schemaBranchName(projectId: string, versionId: string) {
  return `lymtless-${projectId.slice(0, 8)}-${versionId.slice(0, 8)}`.toLowerCase();
}

function migrationLabel(versionId: string, migrationPath: string) {
  const base = path.posix.basename(migrationPath, ".sql").replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `lymtless_${versionId.slice(0, 8)}_${base}`.slice(0, 120);
}

function boundedJson(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 50_000) return value;
  return { truncated: true, preview: `${serialized.slice(0, 49_500)}…` };
}

function clip(value: string) {
  return value.length > 10_000 ? `${value.slice(0, 10_000)}…` : value;
}
