import { createHash } from "node:crypto";
import path from "node:path";
import {
  ensurePublishableKey,
  getSecurityAdvisor,
  mergeDatabaseBranch,
  scheduleDatabaseBranchDeletion,
  securityFindings,
  waitForActionRun,
} from "@/lib/supabase/management";
import { createClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type BuildBackendTarget = {
  env: Record<string, string>;
  connected: boolean;
  schemaRunId: string | null;
  schemaBranchRef: string | null;
  usingSchemaBranch: boolean;
};

export async function resolveBuildBackendTarget(
  supabase: SupabaseClient,
  projectId: string,
  sourceVersionId: string,
): Promise<BuildBackendTarget> {
  const { data: backend } = await supabase
    .from("app_backends")
    .select("id,status,api_url,publishable_key,external_project_ref")
    .eq("project_id", projectId)
    .maybeSingle();

  if (!backend?.external_project_ref) {
    return { env: {}, connected: false, schemaRunId: null, schemaBranchRef: null, usingSchemaBranch: false };
  }

  const { data: schemaRun } = await supabase
    .from("backend_schema_runs")
    .select("id,branch_ref,status")
    .eq("app_backend_id", backend.id)
    .eq("source_version_id", sourceVersionId)
    .maybeSingle();

  if (schemaRun?.status === "validating" && schemaRun.branch_ref) {
    const publishableKey = await ensurePublishableKey(schemaRun.branch_ref);
    return {
      env: {
        VITE_SUPABASE_URL: `https://${schemaRun.branch_ref}.supabase.co`,
        VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      },
      connected: true,
      schemaRunId: schemaRun.id,
      schemaBranchRef: schemaRun.branch_ref,
      usingSchemaBranch: true,
    };
  }

  if (backend.status === "ready" && backend.api_url && backend.publishable_key) {
    return {
      env: {
        VITE_SUPABASE_URL: backend.api_url,
        VITE_SUPABASE_PUBLISHABLE_KEY: backend.publishable_key,
      },
      connected: true,
      schemaRunId: null,
      schemaBranchRef: null,
      usingSchemaBranch: false,
    };
  }

  return { env: {}, connected: false, schemaRunId: null, schemaBranchRef: null, usingSchemaBranch: false };
}

export async function finalizeSchemaBranchAfterQa(options: {
  supabase: SupabaseClient;
  projectId: string;
  userId: string;
  schemaRunId: string | null;
  finalVersionId: string;
}) {
  if (!options.schemaRunId) return { merged: false, cleanupScheduled: false };

  const { data: run, error: runError } = await options.supabase
    .from("backend_schema_runs")
    .select("id,app_backend_id,branch_ref,status")
    .eq("id", options.schemaRunId)
    .single();
  if (runError || !run?.branch_ref) throw new Error(runError?.message || "Schema branch run is missing its branch ref");
  if (run.status === "merged") return { merged: true, cleanupScheduled: true };
  if (run.status !== "validating") throw new Error(`Schema branch cannot merge from status ${run.status}`);

  const { data: backend, error: backendError } = await options.supabase
    .from("app_backends")
    .select("id,external_project_ref")
    .eq("id", run.app_backend_id)
    .eq("project_id", options.projectId)
    .single();
  if (backendError || !backend?.external_project_ref) throw new Error(backendError?.message || "Production backend not found for schema merge");

  await options.supabase.from("backend_schema_runs").update({ status: "merging", error_message: null }).eq("id", run.id);

  try {
    const merge = await mergeDatabaseBranch(run.branch_ref);
    if (!merge.workflow_run_id) throw new Error("Supabase branch merge returned no workflow run ID");
    await waitForActionRun(backend.external_project_ref, merge.workflow_run_id);

    const advisor = await getSecurityAdvisor(backend.external_project_ref);
    const findings = securityFindings(advisor);
    if (findings.length > 0) {
      throw new Error(`Production Supabase security advisor reported ${findings.length} finding${findings.length === 1 ? "" : "s"} after branch merge`);
    }

    await recordMergedMigrations({
      supabase: options.supabase,
      backendId: backend.id,
      projectId: options.projectId,
      versionId: options.finalVersionId,
      userId: options.userId,
    });

    const { error: backendUpdateError } = await options.supabase
      .from("app_backends")
      .update({ status: "ready", schema_version_id: options.finalVersionId, error_message: null })
      .eq("id", backend.id);
    if (backendUpdateError) throw new Error(backendUpdateError.message);

    await options.supabase
      .from("backend_schema_runs")
      .update({ status: "merged", error_message: null })
      .eq("id", run.id);

    let cleanupScheduled = false;
    try {
      await scheduleDatabaseBranchDeletion(run.branch_ref);
      cleanupScheduled = true;
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : "DEV branch cleanup scheduling failed";
      await options.supabase
        .from("backend_schema_runs")
        .update({ status: "cleanup_failed", error_message: clip(`Production merge succeeded. ${message}`) })
        .eq("id", run.id);
    }

    return { merged: true, cleanupScheduled, workflowRunId: merge.workflow_run_id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Schema branch merge failed";
    await options.supabase.from("backend_schema_runs").update({ status: "failed", error_message: clip(message) }).eq("id", run.id);
    throw error;
  }
}

async function recordMergedMigrations(options: {
  supabase: SupabaseClient;
  backendId: string;
  projectId: string;
  versionId: string;
  userId: string;
}) {
  const { data: files, error: filesError } = await options.supabase
    .from("generated_files")
    .select("path,content,content_hash")
    .eq("version_id", options.versionId)
    .like("path", "supabase/migrations/%.sql")
    .order("path", { ascending: true });
  if (filesError) throw new Error(filesError.message);

  for (const file of files || []) {
    const contentHash = file.content_hash || createHash("sha256").update(file.content, "utf8").digest("hex");
    const { data: existing } = await options.supabase
      .from("backend_migrations")
      .select("id,status")
      .eq("app_backend_id", options.backendId)
      .eq("content_hash", contentHash)
      .maybeSingle();
    if (existing?.status === "applied") continue;

    const migrationName = migrationLabel(options.versionId, file.path);
    const payload = {
      app_backend_id: options.backendId,
      project_id: options.projectId,
      source_version_id: options.versionId,
      user_id: options.userId,
      path: file.path,
      content_hash: contentHash,
      migration_name: migrationName,
      status: "applied",
      applied_at: new Date().toISOString(),
      error_message: null,
    };

    const { error } = existing?.id
      ? await options.supabase.from("backend_migrations").update(payload).eq("id", existing.id)
      : await options.supabase.from("backend_migrations").insert(payload);
    if (error) throw new Error(`Could not record merged migration ${file.path}: ${error.message}`);
  }
}

function migrationLabel(versionId: string, migrationPath: string) {
  const base = path.posix.basename(migrationPath, ".sql").replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `lymtless_${versionId.slice(0, 8)}_${base}`.slice(0, 120);
}

function clip(value: string) {
  return value.length > 10_000 ? `${value.slice(0, 10_000)}…` : value;
}
