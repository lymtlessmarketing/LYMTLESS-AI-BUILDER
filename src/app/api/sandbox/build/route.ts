import { Sandbox } from "@vercel/sandbox";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });
const PREVIEW_PORT = 5173;
const ROOT = "/vercel/sandbox/app";

function hasSandboxAuth() {
  return Boolean(
    process.env.VERCEL_OIDC_TOKEN ||
      (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID),
  );
}

export async function POST(request: Request) {
  const supabase = await createClient();
  let sandbox: Sandbox | null = null;

  try {
    const { projectId } = requestSchema.parse(await request.json());
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!hasSandboxAuth()) {
      return NextResponse.json(
        { error: "Vercel Sandbox is not configured. Add VERCEL_OIDC_TOKEN or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID." },
        { status: 503 },
      );
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,current_version_id")
      .eq("id", projectId)
      .single();
    if (projectError || !project?.current_version_id) {
      return NextResponse.json({ error: "Generate an application version before starting a preview" }, { status: 409 });
    }

    const { data: files, error: fileError } = await supabase
      .from("generated_files")
      .select("path,content")
      .eq("version_id", project.current_version_id)
      .order("path");
    if (fileError) throw new Error(fileError.message);
    if (!files?.length) return NextResponse.json({ error: "Generated version contains no files" }, { status: 409 });

    sandbox = await Sandbox.create({
      ports: [PREVIEW_PORT],
      timeout: 15 * 60 * 1000,
      persistent: true,
      resources: { vcpus: 2 },
    });

    await sandbox.runCommand({ cmd: "mkdir", args: ["-p", ROOT] });
    await sandbox.writeFiles(
      files.map((file) => ({ path: `${ROOT}/${file.path}`, content: Buffer.from(file.content, "utf8") })),
    );

    const install = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--no-audit", "--no-fund"],
      cwd: ROOT,
    });
    if (install.exitCode !== 0) {
      const stderr = await install.stderr();
      await sandbox.stop();
      return NextResponse.json({ error: "Dependency installation failed", logs: stderr.slice(-12000) }, { status: 422 });
    }

    const build = await sandbox.runCommand({ cmd: "npm", args: ["run", "build"], cwd: ROOT });
    if (build.exitCode !== 0) {
      const stderr = await build.stderr();
      const stdout = await build.stdout();
      await sandbox.stop();
      return NextResponse.json(
        { error: "Generated application did not build", logs: `${stdout}\n${stderr}`.slice(-16000) },
        { status: 422 },
      );
    }

    await sandbox.runCommand({
      cmd: "npm",
      args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(PREVIEW_PORT)],
      cwd: ROOT,
      detached: true,
    });

    await sandbox.runCommand({
      cmd: "sh",
      args: ["-lc", `for i in $(seq 1 30); do curl -fsS http://127.0.0.1:${PREVIEW_PORT}/ >/dev/null && exit 0; sleep 1; done; exit 1`],
      cwd: ROOT,
    });

    const previewUrl = sandbox.domain(PREVIEW_PORT);
    const { error: deploymentError } = await supabase.from("deployments").insert({
      project_id: projectId,
      version_id: project.current_version_id,
      environment: "preview",
      provider: "vercel-sandbox",
      provider_deployment_id: sandbox.name,
      url: previewUrl,
      status: "ready",
    });
    if (deploymentError) console.warn("Could not persist sandbox deployment:", deploymentError.message);

    await supabase.from("projects").update({ status: "ready" }).eq("id", projectId);

    return NextResponse.json({
      previewUrl,
      sandboxName: sandbox.name,
      versionId: project.current_version_id,
    });
  } catch (error) {
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {}
    }
    const message = error instanceof Error ? error.message : "Sandbox preview failed";
    console.error(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
