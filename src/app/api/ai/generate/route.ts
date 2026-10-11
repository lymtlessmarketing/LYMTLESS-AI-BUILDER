import { createHash } from "node:crypto";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { NextResponse } from "next/server";
import { z } from "zod";
import { generatedAppSchema } from "@/lib/ai/schemas";
import { CODEGEN_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { createClient } from "@/lib/supabase/server";

const requestSchema = z.object({ projectId: z.string().uuid() });
const forbiddenSecretFile = /(^|\/)(\.env|\.env\.local|\.env\.production|credentials\.json|service-account.*\.json)$/i;
const forbiddenRepositoryPath = /^(\.git|\.github)(\/|$)/i;
const maxBundleBytes = 2_000_000;

function validateGeneratedPath(input: string) {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe generated path: ${input}`);
  }
  if (forbiddenSecretFile.test(normalized)) throw new Error(`Generated secret file is not allowed: ${normalized}`);
  if (forbiddenRepositoryPath.test(normalized)) throw new Error(`Generated repository-control file is not allowed: ${normalized}`);
  return normalized;
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
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,name,description,blueprint")
      .eq("id", body.projectId)
      .single();

    if (projectError || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.blueprint || Object.keys(project.blueprint).length === 0) {
      return NextResponse.json({ error: "Create an application plan before generating code" }, { status: 409 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 503 });
    const model = process.env.OPENAI_CODE_MODEL || process.env.OPENAI_MODEL || "gpt-6.1-sol";

    await supabase.from("projects").update({ status: "generating" }).eq("id", body.projectId);

    const { data: run } = await supabase
      .from("ai_runs")
      .insert({ project_id: body.projectId, user_id: user.id, run_type: "generate", model, status: "running" })
      .select("id")
      .single();
    runId = run?.id ?? null;

    const client = new OpenAI({ apiKey });
    const response = await client.responses.parse({
      model,
      input: [
        { role: "system", content: CODEGEN_SYSTEM_PROMPT },
        { role: "user", content: `APPLICATION BLUEPRINT:\n${JSON.stringify(project.blueprint, null, 2)}` },
      ],
      text: { format: zodTextFormat(generatedAppSchema, "generated_application") },
    });

    const generated = response.output_parsed;
    if (!generated) throw new Error("Model returned no parsed generated application");

    const seen = new Set<string>();
    let bundleBytes = 0;
    const files = generated.files.map((file) => {
      const safePath = validateGeneratedPath(file.path);
      if (seen.has(safePath)) throw new Error(`Duplicate generated path: ${safePath}`);
      seen.add(safePath);
      bundleBytes += Buffer.byteLength(file.content, "utf8");
      if (bundleBytes > maxBundleBytes) throw new Error("Generated application exceeds the 2 MB source bundle limit");
      return {
        path: safePath,
        content: file.content,
        contentHash: createHash("sha256").update(file.content, "utf8").digest("hex"),
      };
    });

    const { data: version, error: versionError } = await supabase.rpc("create_project_version", {
      p_project_id: body.projectId,
      p_summary: generated.summary,
    });
    if (versionError || !version) throw new Error(versionError?.message || "Could not create project version");

    const versionRow = Array.isArray(version) ? version[0] : version;
    if (!versionRow?.id) throw new Error("Version creation returned no id");

    const { error: filesError } = await supabase.from("generated_files").insert(
      files.map((file) => ({
        project_id: body.projectId,
        version_id: versionRow.id,
        path: file.path,
        content: file.content,
        content_hash: file.contentHash,
      })),
    );
    if (filesError) throw new Error(filesError.message);

    await Promise.all([
      supabase.from("projects").update({ status: "ready", current_version_id: versionRow.id }).eq("id", body.projectId),
      ...(runId ? [supabase.from("ai_runs").update({
        status: "succeeded",
        input_tokens: response.usage?.input_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
      }).eq("id", runId)] : []),
      supabase.from("messages").insert({
        project_id: body.projectId,
        user_id: user.id,
        role: "assistant",
        content: `Generated version ${versionRow.version_number} with ${files.length} files.`,
        metadata: { versionId: versionRow.id, versionNumber: versionRow.version_number, fileCount: files.length },
      }),
    ]);

    return NextResponse.json({
      version: { id: versionRow.id, number: versionRow.version_number, summary: generated.summary },
      files: files.map((file) => file.path),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to generate application";
    if (runId) await supabase.from("ai_runs").update({ status: "failed", error_message: message }).eq("id", runId);
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid generation request", details: error.issues }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
