import { createHash } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validateGeneratedMigration } from "@/lib/supabase/generated-migration-safety";
import {
  createDatabaseBranch,
  getSecurityAdvisor,
  runDatabaseQuery,
  securityFindings,
  waitForDatabaseBranch,
} from "@/lib/supabase/management";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });

type MigrationFile = {
  path: string;
  content: string;
  contentHash: string;
};

export async function POST(request: Request) {
  const supabase = await createClient();
  let backendId: string | null = null;
  let schemaRunId: string | null = null;
  let branchMode = false;

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

    const { data: version } = await supabase
      .from("versions")
      .select("version_number")
      .eq("id", project.current_version_id)
      .single();

    const { data: backend, error: backendError } = await supabase
      .from("app_backends")
      .select("id,status,external_project_ref,schema_version_id")
      .eq("project_id", projectId)
      .single();
    if (backendError || !backend?.external_project_ref) return NextResponse.json({ error: "Provision the app backend first" }, { status: 409 });
    backendId = backend.id;

    const migrations = await loadMigrations(supabase, project.current_version_id);
    const pending = await pendingMigrations(supabase, backend.id, migrations);

    if (backend.schema_version_id && pending.length > 0) {
      branchMode = true;
      const { data: existingRun } = await supabase
        .from("backend_schema_runs")
        .select("id,branch_name,branch_ref,status,error_message")
        .eq("app_backend_id", backend.id)
        .eq("source_version_id", project.current_version_id)
        .maybeSingle();

      if (existingRun?.status === "merged") {
        return NextResponse.json({
          configured: true,
          schemaBranch: false,
          appliedMigrations: pending.length,
          securityFindings: 0,
        });
      }

      if (existingRun?.status === "validating" && existingRun.branch_ref) {
        return NextResponse.json({
          configured: false,
          schemaBranch: true,
          schemaRunId: existingRun.id,
          branchRef: existingRun.branch_ref,
          branchName: existingRun.branch_name,
          pendingMigrations: pending.length,
          securityFindings: 0,
        });
      }

      const branchName = schemaBranchName(version?.version_number ?? 0, project.current_version_id);
      if (existingRun) {
        schemaRunId = existingRun.id;
        const { error: resetError } = await supabase
          .from("backend_schema_runs")
          .update({
            branch_name: branchName,
            branch_ref: null,
            status: "creating",
            error_message: null,
          })
          .eq("id", existingRun.id);
        if (resetError) throw new Error(resetError.message);
      } else {
        const { data: run, error: runError } = await supabase
          .from("backend_schema_runs")
          .insert({
            app_backend_id: backend.id,
            project_id: projectId,
            source_version_id: project.current_version_id,
            user_id: user.id,
            branch_name: branchName,
            status: "creating",
          })
          .select("id")
          .single();
        if (runError || !run) throw new Error(runError?.message || "Could not create schema preview run");
        schemaRunId = run.id;
      }

      const created = await createDatabaseBranch(backend.external_project_ref, branchName);
      const branchRef = created.project_ref;
      if (!branchRef) throw new Error("Supabase did not return a project ref for the DEV branch");

      await supabase
        .from("backend_schema_runs")
        .update({ branch_ref: branchRef, status: "creating" })
        .eq("id", schemaRunId);

      await waitForDatabaseBranch(backend.external_project_ref, branchName);
      await supabase.from("backend_schema_runs").update({ status: "applying" }).eq("id", schemaRunId);

      for (const migration of pending) {
        validateGeneratedMigration(migration.content);
        await runDatabaseQuery(branchRef, migration.content);
      }

      await supabase.from("backend_schema_runs").update({ status: "validating" }).eq("id", schemaRunId);
      const advisor = await getSecurityAdvisor(branchRef);
      const findings = securityFindings(advisor);
      if (findings.length > 0) {
        throw new Error(`Supabase DEV branch security advisor reported ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
      }

      return NextResponse.json({
        configured: false,
        schemaBranch: true,
        schemaRunId,
        branchRef,
        branchName,
        pendingMigrations: pending.length,
        securityFindings: 0,
      });
    }

    await supabase.from("app_backends").update({ status: "configuring", error_message: null }).eq("id", backend.id);
    await applyInitialMigrations({
      supabase,
      migrations: pending,
      backendId: backend.id,
      projectId,
      versionId: project.current_version_id,
      userId: user.id,
      backendRef: backend.external_project_ref,
    });

    const advisor = await getSecurityAdvisor(backend.external_project_ref);
    const findings = securityFindings(advisor);
    if (findings.length > 0) {
      throw new Error(`Supabase security advisor reported ${findings.length} finding${findings.length === 1 ? "" : "s"} after schema configuration`);
    }

    const { error: readyError } = await supabase
      .from("app_backends")
      .update({ status: "ready", schema_version_id: project.current_version_id, error_message: null })
      .eq("id", backend.id);
    if (readyError) throw new Error(readyError.message);

    return NextResponse.json({ configured: true, schemaBranch: false, appliedMigrations: pending.length, securityFindings: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backend configuration failed";
    if (schemaRunId) {
      await supabase.from("backend_schema_runs").update({ status: "failed", error_message: clip(message) }).eq("id", schemaRunId);
    }
    if (backendId && !branchMode) {
      await supabase.from("app_backends").update({ status: "failed", error_message: clip(message) }).eq("id", backendId);
    }
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid backend request" }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

async function loadMigrations(supabase: Awaited<ReturnType<typeof createClient>>, versionId: string): Promise<MigrationFile[]> {
  const { data: migrationFiles, error } = await supabase
    .from("generated_files")
    .select("path,content,content_hash")
    .eq("version_id", versionId)
    .like("path", "supabase/migrations/%.sql")
    .order("path", { ascending: true });
  if (error) throw new Error(error.message);

  return (migrationFiles || []).map((file) => ({
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
  const { data: appliedRows, error } = await supabase
    .from("backend_migrations")
    .select("content_hash")
    .eq("app_backend_id", backendId)
    .eq("status", "applied");
  if (error) throw new Error(error.message);
  const applied = new Set((appliedRows || []).map((row) => row.content_hash));
  return migrations.filter((migration) => !applied.has(migration.contentHash));
}

async function applyInitialMigrations(options: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  migrations: MigrationFile[];
  backendId: string;
  projectId: string;
  versionId: string;
  userId: string;
  backendRef: string;
}) {
  for (const migration of options.migrations) {
    validateGeneratedMigration(migration.content);
    const migrationName = migrationLabel(options.versionId, migration.path);

    const { data: tracking, error: trackingError } = await options.supabase
      .from("backend_migrations")
      .upsert({
        app_backend_id: options.backendId,
        project_id: options.projectId,
        source_version_id: options.versionId,
        user_id: options.userId,
        path: migration.path,
        content_hash: migration.contentHash,
        migration_name: migrationName,
        status: "applying",
        error_message: null,
      }, { onConflict: "app_backend_id,content_hash" })
      .select("id")
      .single();
    if (trackingError || !tracking) throw new Error(trackingError?.message || "Could not track backend migration");

    try {
      await runDatabaseQuery(options.backendRef, migration.content);
      await options.supabase
        .from("backend_migrations")
        .update({ status: "applied", applied_at: new Date().toISOString(), error_message: null })
        .eq("id", tracking.id);
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : "Database migration failed";
      await options.supabase.from("backend_migrations").update({ status: "failed", error_message: clip(message) }).eq("id", tracking.id);
      throw migrationError;
    }
  }
}

function schemaBranchName(versionNumber: number, versionId: string) {
  return `lymtless-v${Math.max(0, versionNumber)}-${versionId.slice(0, 8)}`.toLowerCase();
}

function migrationLabel(versionId: string, migrationPath: string) {
  const base = path.posix.basename(migrationPath, ".sql").replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `lymtless_${versionId.slice(0, 8)}_${base}`.slice(0, 120);
}

function clip(value: string) {
  return value.length > 10_000 ? `${value.slice(0, 10_000)}…` : value;
}
