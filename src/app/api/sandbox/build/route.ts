import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });
const PREVIEW_PORT = 5173;
const ROOT = "/vercel/sandbox/app";
const MAX_LOG_CHARS = 20_000;

function hasSandboxAuth() {
  return Boolean(
    process.env.VERCEL_OIDC_TOKEN ||
      (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID),
  );
}

function trimLogs(value: string, max = MAX_LOG_CHARS) {
  return value.length > max ? value.slice(-max) : value;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  let sandbox: Sandbox | null = null;
  let projectId: string | null = null;
  let buildRunId: string | null = null;

  async function updateBuildRun(values: Record<string, unknown>) {
    if (!buildRunId) return;
    const { error } = await supabase.from("build_runs").update(values).eq("id", buildRunId);
    if (error) console.warn("Could not update build run:", error.message);
  }

  async function failBuild(error: string, logs = "", status = 422) {
    await updateBuildRun({ status: "failed", error_message: error, build_log: logs || null });
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {}
      sandbox = null;
    }
    return NextResponse.json({ error, logs: trimLogs(logs) }, { status });
  }

  try {
    const { projectId: parsedProjectId } = requestSchema.parse(await request.json());
    projectId = parsedProjectId;

    const { data: authData } = await supabase.auth.getUser();
    const user = authData.user;
    if (!user) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
    if (!hasSandboxAuth()) {
      return NextResponse.json(
        {
          error: "Vercel Sandbox is not configured for this deployment.",
          code: "SANDBOX_NOT_CONFIGURED",
        },
        { status: 503 },
      );
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,current_version_id")
      .eq("id", parsedProjectId)
      .single();
    if (projectError || !project?.current_version_id) {
      return NextResponse.json({ error: "Generate an application version before starting a preview", code: "VERSION_REQUIRED" }, { status: 409 });
    }

    const { data: files, error: fileError } = await supabase
      .from("generated_files")
      .select("path,content")
      .eq("version_id", project.current_version_id)
      .order("path");
    if (fileError) throw new Error(fileError.message);
    if (!files?.length) return NextResponse.json({ error: "Generated version contains no files", code: "EMPTY_VERSION" }, { status: 409 });

    const packageFile = files.find((file) => file.path === "package.json");
    if (!packageFile) return NextResponse.json({ error: "Generated version is missing package.json", code: "INVALID_GENERATED_APP" }, { status: 422 });
    try {
      const packageJson = JSON.parse(packageFile.content) as { scripts?: Record<string, unknown> };
      if (typeof packageJson.scripts?.build !== "string" || typeof packageJson.scripts?.dev !== "string") {
        return NextResponse.json({ error: "Generated package.json must include build and dev scripts", code: "INVALID_GENERATED_APP" }, { status: 422 });
      }
    } catch {
      return NextResponse.json({ error: "Generated package.json is invalid JSON", code: "INVALID_GENERATED_APP" }, { status: 422 });
    }

    const { data: buildRun, error: buildRunError } = await supabase
      .from("build_runs")
      .insert({
        project_id: parsedProjectId,
        version_id: project.current_version_id,
        user_id: user.id,
        provider: "vercel-sandbox",
        status: "creating",
      })
      .select("id")
      .single();
    if (buildRunError) console.warn("Could not create build run:", buildRunError.message);
    buildRunId = buildRun?.id ?? null;

    sandbox = await Sandbox.create({
      ports: [PREVIEW_PORT],
      timeout: 15 * 60 * 1000,
      persistent: true,
      resources: { vcpus: 2 },
    });
    await updateBuildRun({ status: "installing", sandbox_id: sandbox.name, sandbox_name: sandbox.name });

    await sandbox.runCommand({ cmd: "mkdir", args: ["-p", ROOT] });
    await sandbox.writeFiles(
      files.map((file) => ({ path: `${ROOT}/${file.path}`, content: Buffer.from(file.content, "utf8") })),
    );

    const install = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--no-audit", "--no-fund"],
      cwd: ROOT,
    });
    const installStdout = await install.stdout();
    const installStderr = await install.stderr();
    const installLogs = trimLogs(`${installStdout}\n${installStderr}`);
    await updateBuildRun({ install_log: installLogs });
    if (install.exitCode !== 0) return failBuild("Dependency installation failed", installLogs);

    await updateBuildRun({ status: "building" });
    const build = await sandbox.runCommand({ cmd: "npm", args: ["run", "build"], cwd: ROOT });
    const buildStdout = await build.stdout();
    const buildStderr = await build.stderr();
    const buildLogs = trimLogs(`${buildStdout}\n${buildStderr}`);
    await updateBuildRun({ build_log: buildLogs });
    if (build.exitCode !== 0) return failBuild("Generated application did not build", buildLogs);

    await updateBuildRun({ status: "starting" });
    await sandbox.runCommand({
      cmd: "npm",
      args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(PREVIEW_PORT)],
      cwd: ROOT,
      detached: true,
    });

    const readiness = await sandbox.runCommand({
      cmd: "sh",
      args: ["-lc", `for i in $(seq 1 45); do curl -fsS http://127.0.0.1:${PREVIEW_PORT}/ >/dev/null && exit 0; sleep 1; done; echo 'Preview server did not become ready on port ${PREVIEW_PORT}' >&2; exit 1`],
      cwd: ROOT,
    });
    const readinessStdout = await readiness.stdout();
    const readinessStderr = await readiness.stderr();
    const previewLogs = trimLogs(`${readinessStdout}\n${readinessStderr}`);
    await updateBuildRun({ preview_log: previewLogs });
    if (readiness.exitCode !== 0) return failBuild("Generated application built but its preview server did not start", previewLogs);

    const previewUrl = sandbox.domain(PREVIEW_PORT);
    if (!previewUrl) return failBuild("Sandbox did not return a preview URL");

    const { error: deploymentError } = await supabase.from("deployments").insert({
      project_id: parsedProjectId,
      version_id: project.current_version_id,
      environment: "preview",
      provider: "vercel-sandbox",
      provider_deployment_id: sandbox.name,
      url: previewUrl,
      status: "ready",
    });
    if (deploymentError) console.warn("Could not persist sandbox deployment:", deploymentError.message);

    await updateBuildRun({ status: "ready", preview_url: previewUrl, error_message: null });
    await supabase.from("projects").update({ status: "ready" }).eq("id", parsedProjectId);

    return NextResponse.json({
      previewUrl,
      sandboxName: sandbox.name,
      versionId: project.current_version_id,
      buildRunId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid sandbox build request", code: "INVALID_SANDBOX_REQUEST", details: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Sandbox preview failed";
    await updateBuildRun({ status: "failed", error_message: message });
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {}
    }
    console.error("Sandbox build failed:", error);
    return NextResponse.json({ error: message, code: "SANDBOX_BUILD_FAILED" }, { status: 500 });
  }
}
