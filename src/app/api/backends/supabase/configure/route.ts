import { createHash } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validateGeneratedMigration } from "@/lib/supabase/generated-migration-safety";
import { getSecurityAdvisor, runDatabaseQuery, securityFindings } from "@/lib/supabase/management";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });

export async function POST(request: Request) {
  const supabase = await createClient();
  let backendId: string | null = null;

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

    const { data: migrationFiles, error: filesError } = await supabase
      .from("generated_files")
      .select("path,content,content_hash")
      .eq("version_id", project.current_version_id)
      .like("path", "supabase/migrations/%.sql")
      .order("path", { ascending: true });
    if (filesError) throw new Error(filesError.message);

    const migrations = (migrationFiles || []).map((file) => ({
      path: file.path,
      content: file.content,
      contentHash: file.content_hash || createHash("sha256").update(file.content, "utf8").digest("hex"),
    }));

    const { data: appliedRows, error: appliedError } = await supabase
      .from("backend_migrations")
      .select("content_hash")
      .eq("app_backend_id", backend.id)
      .eq("status", "applied");
    if (appliedError) throw new Error(appliedError.message);
    const applied = new Set((appliedRows || []).map((row) => row.content_hash));
    const pending = migrations.filter((migration) => !applied.has(migration.contentHash));

    if (backend.schema_version_id && pending.length > 0) {
      return NextResponse.json(
        { error: "This version changes the database schema. DEV-branch schema evolution is required before modifying a configured live backend." },
        { status: 409 },
      );
    }

    await supabase.from("app_backends").update({ status: "configuring", error_message: null }).eq("id", backend.id);

    for (const migration of pending) {
      validateGeneratedMigration(migration.content);
      const migrationName = migrationLabel(project.current_version_id, migration.path);

      const { data: tracking, error: trackingError } = await supabase
        .from("backend_migrations")
        .upsert({
          app_backend_id: backend.id,
          project_id: projectId,
          source_version_id: project.current_version_id,
          user_id: user.id,
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
        await runDatabaseQuery(backend.external_project_ref, migration.content);
        await supabase
          .from("backend_migrations")
          .update({ status: "applied", applied_at: new Date().toISOString(), error_message: null })
          .eq("id", tracking.id);
      } catch (migrationError) {
        const message = migrationError instanceof Error ? migrationError.message : "Database migration failed";
        await supabase.from("backend_migrations").update({ status: "failed", error_message: clip(message) }).eq("id", tracking.id);
        throw migrationError;
      }
    }

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

    return NextResponse.json({ configured: true, appliedMigrations: pending.length, securityFindings: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backend configuration failed";
    if (backendId) await supabase.from("app_backends").update({ status: "failed", error_message: clip(message) }).eq("id", backendId);
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid backend request" }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

function migrationLabel(versionId: string, migrationPath: string) {
  const base = path.posix.basename(migrationPath, ".sql").replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `lymtless_${versionId.slice(0, 8)}_${base}`.slice(0, 120);
}

function clip(value: string) {
  return value.length > 10_000 ? `${value.slice(0, 10_000)}…` : value;
}
