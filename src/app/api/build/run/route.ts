import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  repairBrowserQaFailure,
  repairBuildFailure,
  repairVisualQaFailure,
} from "@/lib/ai/repair";
import { reviewVisuals } from "@/lib/ai/visual-review";
import {
  buildApplication,
  clipLog,
  createBuildSandbox,
  installBrowserQa,
  installDependencies,
  lockSandboxNetwork,
  runBrowserQa,
  safeSourcePath,
  sandboxAuthConfigured,
  startPreview,
  stopPreview,
  type BrowserQaFinding,
  type SourceFile,
  writeSourceFiles,
} from "@/lib/sandbox/build";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });
const MAX_REPAIRS = 2;
const MAX_SOURCE_BYTES = 2_000_000;

type VisualFinding = {
  severity: "error" | "warning";
  viewport: "desktop" | "tablet" | "mobile" | "all";
  category: string;
  issue: string;
  recommendation: string;
};

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

    const qaRoutes = blueprintRoutes(project.blueprint);
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
    const sandboxEnv: Record<string, string> = backend?.status === "ready" && backend.api_url && backend.publishable_key
      ? {
          VITE_SUPABASE_URL: String(backend.api_url),
          VITE_SUPABASE_PUBLISHABLE_KEY: String(backend.publishable_key),
        }
      : {};

    const { data: buildRun, error: buildRunError } = await supabase
      .from("build_runs")
      .insert({
        project_id: requestedProjectId,
        version_id: currentVersionId,
        user_id: user.id,
        status: "creating",
        qa_status: "pending",
        visual_status: "pending",
      })
      .select("id")
      .single();
    if (buildRunError || !buildRun) throw new Error(buildRunError?.message || "Could not create build run");
    const activeBuildRunId = String(buildRun.id);
    buildRunId = activeBuildRunId;

    sandbox = await createBuildSandbox(sandboxEnv);
    await updateBuildRun(supabase, activeBuildRunId, { sandbox_name: sandbox.name, status: "installing" });
    await writeSourceFiles(sandbox, files);

    let repairAttempts = 0;
    let installLog = "";
    let buildLog = "";
    let qaLog = "";
    let visualLog = "";
    let previewLog = "";
    let qaFindings: BrowserQaFinding[] = [];
    let visualFindings: VisualFinding[] = [];
    let visualScore: number | null = null;
    let previewUrl = "";

    while (true) {
      await updateBuildRun(supabase, activeBuildRunId, { status: "installing", repair_attempts: repairAttempts });
      const install = await installDependencies(sandbox);
      installLog = appendAttemptLog(installLog, repairAttempts + 1, "npm install", install.combined);
      await updateBuildRun(supabase, activeBuildRunId, { install_log: installLog });

      if (install.exitCode !== 0) {
        const failure = `DEPENDENCY INSTALL FAILED\n${install.combined}`;
        ({ files, currentVersionId, repairAttempts } = await repairFailure({
          supabase,
          sandbox,
          buildRunId: activeBuildRunId,
          projectId: requestedProjectId,
          userId: user.id,
          blueprint: project.blueprint,
          files,
          currentVersionId,
          repairAttempts,
          failure,
          kind: "build",
        }));
        continue;
      }

      await updateBuildRun(supabase, activeBuildRunId, { status: "building" });
      const build = await buildApplication(sandbox);
      buildLog = appendAttemptLog(buildLog, repairAttempts + 1, "npm run build", build.combined);
      await updateBuildRun(supabase, activeBuildRunId, { build_log: buildLog });

      if (build.exitCode !== 0) {
        const failure = `APPLICATION BUILD FAILED\n${build.combined}`;
        ({ files, currentVersionId, repairAttempts } = await repairFailure({
          supabase,
          sandbox,
          buildRunId: activeBuildRunId,
          projectId: requestedProjectId,
          userId: user.id,
          blueprint: project.blueprint,
          files,
          currentVersionId,
          repairAttempts,
          failure,
          kind: "build",
        }));
        continue;
      }

      await updateBuildRun(supabase, activeBuildRunId, { status: "starting", version_id: currentVersionId });
      const qaInstallLog = await installBrowserQa(sandbox);
      qaLog = appendAttemptLog(qaLog, repairAttempts + 1, "install Playwright/Chromium", qaInstallLog);

      const preview = await startPreview(sandbox);
      previewUrl = preview.previewUrl;
      previewLog = appendAttemptLog(previewLog, repairAttempts + 1, "Vite preview", preview.previewLog);
      await updateBuildRun(supabase, activeBuildRunId, {
        status: "testing",
        qa_status: "running",
        visual_status: "pending",
        preview_url: previewUrl,
        preview_log: previewLog,
        qa_log: qaLog,
        version_id: currentVersionId,
      });

      const qa = await runBrowserQa(sandbox, qaRoutes);
      qaFindings = qa.result.findings;
      qaLog = appendAttemptLog(qaLog, repairAttempts + 1, "Playwright browser QA", qa.log);
      await updateBuildRun(supabase, activeBuildRunId, {
        qa_status: qa.result.passed ? "passed" : "failed",
        qa_log: qaLog,
        qa_findings: qaFindings,
      });

      if (!qa.result.passed) {
        await stopPreview(sandbox);
        const failure = `BROWSER QA FAILED\n${qa.log}`;
        ({ files, currentVersionId, repairAttempts } = await repairFailure({
          supabase,
          sandbox,
          buildRunId: activeBuildRunId,
          projectId: requestedProjectId,
          userId: user.id,
          blueprint: project.blueprint,
          files,
          currentVersionId,
          repairAttempts,
          failure,
          kind: "qa",
        }));
        continue;
      }

      await updateBuildRun(supabase, activeBuildRunId, { visual_status: "running" });
      const visualRun = await supabase
        .from("ai_runs")
        .insert({
          project_id: requestedProjectId,
          user_id: user.id,
          run_type: "review",
          model: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-6.1-sol",
          status: "running",
        })
        .select("id")
        .single();

      try {
        const visual = await reviewVisuals({ sandbox, blueprint: project.blueprint });
        visualFindings = visual.review.findings;
        visualScore = visual.review.score;
        visualLog = appendAttemptLog(visualLog, repairAttempts + 1, "AI visual QA", JSON.stringify(visual.review, null, 2));

        await updateBuildRun(supabase, activeBuildRunId, {
          visual_status: visual.review.passed ? "passed" : "failed",
          visual_log: visualLog,
          visual_findings: visualFindings,
        });

        if (visualRun.data?.id) {
          await supabase
            .from("ai_runs")
            .update({ status: "succeeded", input_tokens: visual.inputTokens, output_tokens: visual.outputTokens })
            .eq("id", visualRun.data.id);
        }

        if (visual.review.passed) break;

        await stopPreview(sandbox);
        const failure = `VISUAL QA FAILED\nScore: ${visual.review.score}/100\n${JSON.stringify(visual.review.findings, null, 2)}`;
        ({ files, currentVersionId, repairAttempts } = await repairFailure({
          supabase,
          sandbox,
          buildRunId: activeBuildRunId,
          projectId: requestedProjectId,
          userId: user.id,
          blueprint: project.blueprint,
          files,
          currentVersionId,
          repairAttempts,
          failure,
          kind: "visual",
        }));
      } catch (visualError) {
        const message = visualError instanceof Error ? visualError.message : "Visual QA failed";
        if (visualRun.data?.id) {
          await supabase.from("ai_runs").update({ status: "failed", error_message: clipLog(message, 10_000) }).eq("id", visualRun.data.id);
        }
        throw visualError;
      }
    }

    await lockSandboxNetwork(sandbox);
    await supabase.from("versions").update({ status: "tested" }).eq("id", currentVersionId);
    await supabase.from("projects").update({ status: "ready" }).eq("id", requestedProjectId);
    await updateBuildRun(supabase, activeBuildRunId, {
      status: "ready",
      qa_status: "passed",
      qa_log: qaLog,
      qa_findings: qaFindings,
      visual_status: "passed",
      visual_log: visualLog,
      visual_findings: visualFindings,
      preview_url: previewUrl,
      preview_log: previewLog,
      error_message: null,
      version_id: currentVersionId,
      repair_attempts: repairAttempts,
    });

    return NextResponse.json({
      buildRunId: activeBuildRunId,
      sandboxName: sandbox.name,
      versionId: currentVersionId,
      previewUrl,
      repairAttempts,
      backendConnected: Object.keys(sandboxEnv).length > 0,
      qa: { passed: true, findings: qaFindings, routes: qaRoutes },
      visualQa: { passed: true, score: visualScore, findings: visualFindings },
      installLog,
      buildLog,
      qaLog,
      visualLog,
      previewLog,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox build failed";
    if (buildRunId) {
      await updateBuildRun(supabase, buildRunId, {
        status: "failed",
        qa_status: "failed",
        visual_status: "failed",
        error_message: clipLog(message, 30_000),
      });
    }
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    if (sandbox) {
      try { await sandbox.stop(); } catch { /* sandbox timeout is the second cleanup boundary */ }
    }
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid build request" }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

type RepairFailureOptions = {
  supabase: SupabaseClient;
  sandbox: Awaited<ReturnType<typeof createBuildSandbox>>;
  buildRunId: string;
  projectId: string;
  userId: string;
  blueprint: unknown;
  files: SourceFile[];
  currentVersionId: string;
  repairAttempts: number;
  failure: string;
  kind: "build" | "qa" | "visual";
};

async function repairFailure(options: RepairFailureOptions) {
  await options.supabase.from("versions").update({ status: "failed" }).eq("id", options.currentVersionId);
  if (options.repairAttempts >= MAX_REPAIRS) {
    const gate = options.kind === "qa" ? "browser QA" : options.kind === "visual" ? "visual QA" : "the build";
    throw new Error(`Application did not pass ${gate} after ${MAX_REPAIRS} automated repair attempts. ${clipLog(options.failure, 20_000)}`);
  }

  const nextAttempt = options.repairAttempts + 1;
  await updateBuildRun(options.supabase, options.buildRunId, { status: "repairing", repair_attempts: nextAttempt });

  const model = process.env.OPENAI_REPAIR_MODEL || process.env.OPENAI_CODE_MODEL || process.env.OPENAI_MODEL || "gpt-6.1-sol";
  const repairRun = await options.supabase
    .from("ai_runs")
    .insert({ project_id: options.projectId, user_id: options.userId, run_type: "repair", model, status: "running" })
    .select("id")
    .single();

  try {
    const repair = options.kind === "qa"
      ? await repairBrowserQaFailure({ files: options.files, qaLog: options.failure, blueprint: options.blueprint })
      : options.kind === "visual"
        ? await repairVisualQaFailure({ files: options.files, visualLog: options.failure, blueprint: options.blueprint })
        : await repairBuildFailure({ files: options.files, buildLog: options.failure, blueprint: options.blueprint });

    const changedFiles = repair.patch.changes.map((change) => {
      const safePath = safeSourcePath(change.path);
      if (safePath.startsWith("supabase/migrations/")) throw new Error("Automated repair cannot modify database migrations");
      return {
        path: safePath,
        content: change.content,
        content_hash: createHash("sha256").update(change.content, "utf8").digest("hex"),
      };
    });

    if (!changedFiles.length) throw new Error("Repair model returned an empty patch");
    const files = applyRepair(options.files, changedFiles);
    validateBundleSize(files);

    const { data: version, error: versionError } = await options.supabase.rpc("commit_project_generation", {
      p_project_id: options.projectId,
      p_summary: `Automated ${options.kind === "qa" ? "browser QA" : options.kind === "visual" ? "visual QA" : "build"} repair ${nextAttempt}: ${repair.patch.summary}`,
      p_files: files.map((file) => ({ path: file.path, content: file.content, content_hash: file.content_hash })),
    });
    if (versionError || !version) throw new Error(versionError?.message || "Could not persist repaired version");

    const versionRow = Array.isArray(version) ? version[0] : version;
    if (!versionRow?.id) throw new Error("Repair version returned no id");
    const currentVersionId = versionRow.id as string;

    await updateBuildRun(options.supabase, options.buildRunId, {
      version_id: currentVersionId,
      repair_attempts: nextAttempt,
      qa_status: "pending",
      visual_status: "pending",
      qa_findings: [],
      visual_findings: [],
    });
    await writeSourceFiles(options.sandbox, changedFiles);

    if (repairRun.data?.id) {
      await options.supabase
        .from("ai_runs")
        .update({ status: "succeeded", input_tokens: repair.inputTokens, output_tokens: repair.outputTokens })
        .eq("id", repairRun.data.id);
    }

    return { files, currentVersionId, repairAttempts: nextAttempt };
  } catch (repairError) {
    const message = repairError instanceof Error ? repairError.message : "Repair failed";
    if (repairRun.data?.id) {
      await options.supabase.from("ai_runs").update({ status: "failed", error_message: message }).eq("id", repairRun.data.id);
    }
    throw repairError;
  }
}

function blueprintRoutes(blueprint: unknown): string[] {
  if (!blueprint || typeof blueprint !== "object" || !("pages" in blueprint)) return ["/"];
  const pages = (blueprint as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return ["/"];

  const routes: string[] = [];
  for (const page of pages) {
    if (!page || typeof page !== "object" || !("route" in page)) continue;
    const route = (page as { route?: unknown }).route;
    if (typeof route === "string") routes.push(route);
  }
  return routes.length ? routes : ["/"];
}

async function loadVersionFiles(supabase: SupabaseClient, versionId: string): Promise<SourceFile[]> {
  const { data, error } = await supabase
    .from("generated_files")
    .select("path,content,content_hash")
    .eq("version_id", versionId)
    .order("path", { ascending: true });
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

async function updateBuildRun(supabase: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const { error } = await supabase.from("build_runs").update(cleanPatch).eq("id", id);
  if (error) console.warn("Build run status update failed:", error.message);
}
