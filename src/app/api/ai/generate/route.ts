import { createHash } from "node:crypto";
import path from "node:path";
import { zodTextFormat } from "openai/helpers/zod";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAIClient, getCodeModel } from "@/lib/ai/client";
import { generatedAppSchema } from "@/lib/ai/schemas";
import { CODEGEN_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });
const forbiddenSecretFile = /(^|\/)(\.env|\.env\.local|\.env\.production|credentials\.json|service-account.*\.json)$/i;
const forbiddenRepositoryPath = /^(\.git|\.github)(\/|$)/i;
const maxBundleBytes = 3_000_000;

function validateGeneratedPath(input: string) {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe generated path: ${input}`);
  }
  if (forbiddenSecretFile.test(normalized)) throw new Error(`Generated secret file is not allowed: ${normalized}`);
  if (forbiddenRepositoryPath.test(normalized)) throw new Error(`Generated repository-control file is not allowed: ${normalized}`);
  return normalized;
}

function validateProjectScaffold(files: Array<{ path: string; content: string }>) {
  const byPath = new Map(files.map((file) => [file.path.toLowerCase(), file.content]));
  const packageJson = byPath.get("package.json");
  if (!packageJson) throw new Error("Generated application is missing package.json");
  if (!byPath.has("index.html")) throw new Error("Generated Vite application is missing index.html");
  if (![...byPath.keys()].some((filePath) => filePath.startsWith("src/"))) {
    throw new Error("Generated application is missing source files under src/");
  }

  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    if (typeof parsed.scripts?.build !== "string") throw new Error("package.json is missing a build script");
    if (typeof parsed.scripts?.dev !== "string") throw new Error("package.json is missing a dev script");
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Generated package.json is not valid JSON");
    throw error;
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  let runId: string | null = null;
  let projectId: string | null = null;

  try {
    const body = requestSchema.parse(await request.json());
    projectId = body.projectId;
    const { data: authData } = await supabase.auth.getUser();
    const user = authData.user;
    if (!user) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,name,description,blueprint")
      .eq("id", body.projectId)
      .single();

    if (projectError || !project) return NextResponse.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
    if (!project.blueprint || Object.keys(project.blueprint).length === 0) {
      return NextResponse.json({ error: "Create an application plan before generating code", code: "BLUEPRINT_REQUIRED" }, { status: 409 });
    }

    const model = getCodeModel();

    const { error: statusError } = await supabase.from("projects").update({ status: "generating" }).eq("id", body.projectId);
    if (statusError) throw new Error(statusError.message);

    const { data: run, error: runError } = await supabase
      .from("ai_runs")
      .insert({ project_id: body.projectId, user_id: user.id, run_type: "generate", model, status: "running" })
      .select("id")
      .single();
    if (runError) throw new Error(runError.message);
    runId = run?.id ?? null;

    const client = createAIClient(request.headers.get("x-vercel-oidc-token"));
    const response = await client.responses.parse({
      model,
      input: [
        { role: "system", content: CODEGEN_SYSTEM_PROMPT },
        { role: "user", content: `APPLICATION BLUEPRINT:\n${JSON.stringify(project.blueprint, null, 2)}` },
      ],
      text: { format: zodTextFormat(generatedAppSchema, "generated_application") },
    });

    const generated = response.output_parsed;
    if (!generated) throw new Error("The code-generation model returned no valid application bundle.");

    const seen = new Set<string>();
    let bundleBytes = 0;
    const files = generated.files.map((file) => {
      const safePath = validateGeneratedPath(file.path);
      if (seen.has(safePath)) throw new Error(`Duplicate generated path: ${safePath}`);
      seen.add(safePath);
      bundleBytes += Buffer.byteLength(file.content, "utf8");
      if (bundleBytes > maxBundleBytes) throw new Error("Generated application exceeds the 3 MB source bundle limit");
      return {
        path: safePath,
        content: file.content,
        content_hash: createHash("sha256").update(file.content, "utf8").digest("hex"),
      };
    });

    validateProjectScaffold(files);

    const { data: version, error: commitError } = await supabase.rpc("commit_project_generation", {
      p_project_id: body.projectId,
      p_summary: generated.summary,
      p_files: files,
    });
    if (commitError || !version) throw new Error(commitError?.message || "Could not commit generated application");

    const versionRow = Array.isArray(version) ? version[0] : version;
    if (!versionRow?.id) throw new Error("Generation commit returned no version id");

    const auditResults = await Promise.all([
      runId
        ? supabase.from("ai_runs").update({
            status: "succeeded",
            input_tokens: response.usage?.input_tokens ?? null,
            output_tokens: response.usage?.output_tokens ?? null,
          }).eq("id", runId)
        : Promise.resolve({ error: null }),
      supabase.from("messages").insert({
        project_id: body.projectId,
        user_id: user.id,
        role: "assistant",
        content: `Generated version ${versionRow.version_number} with ${files.length} files.`,
        metadata: { versionId: versionRow.id, versionNumber: versionRow.version_number, fileCount: files.length },
      }),
    ]);
    auditResults.forEach((result) => {
      if (result.error) console.warn("Generation audit write failed:", result.error.message);
    });

    return NextResponse.json({
      version: { id: versionRow.id, number: versionRow.version_number, summary: generated.summary },
      files: files.map((file) => file.path),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid generation request", code: "INVALID_GENERATION_REQUEST", details: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unable to generate application";
    if (runId) await supabase.from("ai_runs").update({ status: "failed", error_message: message }).eq("id", runId);
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    console.error("Generation failed:", error);
    return NextResponse.json({ error: message, code: "GENERATION_FAILED" }, { status: 500 });
  }
}
