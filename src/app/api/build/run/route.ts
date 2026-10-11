import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { repairBuildFailure } from "@/lib/ai/repair";
import {
  buildApplication,
  clipLog,
  createBuildSandbox,
  installDependencies,
  safeSourcePath,
  sandboxAuthConfigured,
  startPreview,
  type SourceFile,
  writeSourceFiles,
} from "@/lib/sandbox/build";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });
const MAX_REPAIRS = 2;
const MAX_SOURCE_BYTES = 2_000_000;

export async function POST(request: Request) {
  const supabase = await createClient();
  let sandbox: Awaited<ReturnType<typeof createBuildSandbox>> | null = null;
  let buildRunId: string | null = null;
  let projectId: string | null = null;

  try {
    const { projectId: requestedProjectId } = requestSchema.parse(await request.json());
    projectId = requestedProjectId;

    const { data: authData } = await supabase.auth.getUser();
    const user = authData.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!sandboxAuthConfigured()) {
      return NextResponse.json(
        { error: "Vercel Sandbox authentication is not configured", setup: "Use VERCEL_OIDC_TOKEN or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID." },
        { status: 503 },
      );
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,current_version_id,blueprint")
      .eq("id", requestedProjectId)
      .single();
    if (projectError || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.current_version_id) return NextResponse.json({ error: "Generate an application version first" }, { status: 409 });

    let currentVersionId = project.current_version_id as string;
    let files = await loadVersionFiles(supabase, currentVersionId);
    if (!files.some((file) => file.path === "package.json")) {
      return NextResponse.json({ error: "Generated application is missing package.json" }, { status: 422 });
    }

    const { data: backend } = await supabase
      .from("app_backends")
      .select("status,api_url,publishable_key")
      .eq("project_id", requestedProjectId)
      .maybeSingle();
    const sandboxEnv = backend?.status === "ready" && backend.api_url && backend.publishable_key
      ? { VITE_SUPABASE_URL: backend.api_url, VITE_SUPABASE_PUBLISHABLE_KEY: backend.publishable_key }
      : {};

    const { data: buildRun, error: buildRunError } = await supabase
      .from("build_runs")
      .insert({ project_id: requestedProjectId, version_id: currentVersionId, user_id: user.id, status: "creating" })
      .select("id")
      .single();
    if (buildRunError || !buildRun) throw new Error(buildRunError?.message || "Could not create build run");
    buildRunId = buildRun.id;

    sandbox = await createBuildSandbox(sandboxEnv);
    await updateBuildRun(supabase, buildRunId, { sandbox_name: sandbox.name, status: "installing" });
    await writeSourceFiles(sandbox, files);

    let repairAttempts = 0;
    let installLog = "";
    let buildLog = "";

    while (true) {
      await updateBuildRun(supabase, buildRunId, { status: "installing", repair_attempts: repairAttempts });
      const install = await installDependencies(sandbox);
      installLog = appendAttemptLog(installLog, repairAttempts + 1, "npm install", install.combined);
      await updateBuildRun(supabase, buildRunId, { install_log: installLog });

      let failureLog = "";
      if (install.exitCode !== 0) {
        failureLog = `DEPENDENCY INSTALL FAILED\n${install.combined}`;
      } else {
        await updateBuildRun(supabase, buildRunId, { status: "building" });
        const build = await buildApplication(sandbox);
        buildLog = appendAttemptLog(buildLog, repairAttempts + 1, "npm run build", build.combined);
        await updateBuildRun(supabase, buildRunId, { build_log: buildLog });
        if (build.exitCode === 0) break;
        failureLog = `APPLICATION BUILD FAILED\n${build.combined}`;
      }

      await supabase.from("versions").update({ status: "failed" }).eq("id", currentVersionId);
      if (repairAttempts >= MAX_REPAIRS) {
        throw new Error(`Application did not build after ${MAX_REPAIRS} automated repair attempts. ${clipLog(failureLog, 20_000)}`);
      }

      repairAttempts += 1;
      await updateBuildRun(supabase, buildRunId, { status: "repairing", repair_attempts: repairAttempts });
      const repairRun = await supabase
        .from("ai_runs")
        .insert({
          project_id: requestedProjectId,
          user_id: user.id,
          run_type: "repair",
          model: process.env.OPENAI_REPAIR_MODEL || process.env.OPENAI_CODE_MODEL || process.env.OPENAI_MODEL || "gpt-6.1-sol",
          status: "running",
        })
        .select("id")
        .single();

      try {
        const repair = await repairBuildFailure({ files, buildLog: failureLog, blueprint: project.blueprint });
        const changedFiles = repair.patch.changes.map((change) => {
          const safePath = safeSourcePath(change.path);
          if (safePath.startsWith("supabase/migrations/")) throw new Error("Build repair cannot modify database migrations");
          return {
            path: safePath,
            content: change.content,
            content_hash: createHash("sha256").update(change.content, "utf8").digest("hex"),
          };
        });

        files = applyRepair(files, changedFiles);
        validateBundleSize(files);
        const { data: version, error: versionError } = await supabase.rpc("commit_project_generation", {
          p_project_id: requestedProjectId,
          p_summary: `Automated repair ${repairAttempts}: ${repair.patch.summary}`,
          p_files: files.map((file) => ({ path: file.path, content: file.content, content_hash: file.content_hash })),
        });
        if (versionError || !version) throw new Error(versionError?.message || "Could not persist repaired version");

        const versionRow = Array.isArray(version) ? version[0] : version;
        if (!versionRow?.id) throw new Error("Repair version returned no id");
        currentVersionId = versionRow.id;
        await updateBuildRun(supabase, buildRunId, { version_id: currentVersionId, repair_attempts: repairAttempts });
        await writeSourceFiles(sandbox, changedFiles);

        if (repairRun.data?.id) {
          await supabase.from("ai_runs").update({ status: "succeeded", input_tokens: repair.inputTokens, output_tokens: repair.outputTokens }).eq("id", repairRun.data.id);
        }
      } catch (repairError) {
        const message = repairError instanceof Error ? repairError.message : "Repair failed";
        if (repairRun.data?.id) await supabase.from("ai_runs").update({ status: "failed", error_message: message }).eq("id", repairRun.data.id);
        throw repairError;
      }
    }

    await supabase.from("versions").update({ status: "tested" }).eq("id", currentVersionId);
    await updateBuildRun(supabase, buildRunId, { status: "starting", version_id: currentVersionId });
    const preview = await startPreview(sandbox);
    await updateBuildRun(supabase, buildRunId, {
      status: "ready",
      preview_url: preview.previewUrl,
      preview_log: preview.previewLog,
      error_message: null,
      version_id: currentVersionId,
      repair_attempts: repairAttempts,
    });

    return NextResponse.json({
      buildRunId,
      sandboxName: sandbox.name,
      versionId: currentVersionId,
      previewUrl: preview.previewUrl,
      repairAttempts,
      backendConnected: Object.keys(sandboxEnv).length > 0,
      installLog,
      buildLog,
      previewLog: preview.previewLog,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox build failed";
    if (buildRunId) await updateBuildRun(supabase, buildRunId, { status: "failed", error_message: clipLog(message, 30_000) });
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    if (sandbox) {
      try { await sandbox.stop(); } catch { /* timeout is the second cleanup boundary */ }
    }
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid build request" }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

async function loadVersionFiles(supabase: Awaited<ReturnType<typeof createClient>>, versionId: string): Promise<SourceFile[]> {
  const { data, error } = await supabase.from("generated_files").select("path,content,content_hash").eq("version_id", versionId).order("path", { ascending: true });
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Generated version has no source files");
  return data.map((file) => ({ path: safeSourcePath(file.path), content: file.content, content_hash: file.content_hash }));
}

function applyRepair(files: SourceFile[], changes: SourceFile[]) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const change of changes) byPath.set(change.path, change);
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function validateBundleSize(files: SourceFile[]) {
  const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  if (bytes > MAX_SOURCE_BYTES) throw new Error("Repaired application exceeds the 2 MB source bundle limit");
}

function appendAttemptLog(existing: string, attempt: number, command: string, log: string) {
  return clipLog(`${existing}\n\n===== ATTEMPT ${attempt}: ${command} =====\n${log}`.trim());
}

async function updateBuildRun(supabase: Awaited<ReturnType<typeof createClient>>, id: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from("build_runs").update(patch).eq("id", id);
  if (error) console.warn("Build run status update failed:", error.message);
}
