import { createHash } from "node:crypto";
import path from "node:path";
import { zodTextFormat } from "openai/helpers/zod";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAIClient, getCodeModel } from "@/lib/ai/client";
import { repairPatchSchema } from "@/lib/ai/schemas";
import { REPAIR_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const requestSchema = z.object({
  projectId: z.string().uuid(),
  logs: z.string().min(1).max(20_000),
});
const forbiddenSecretFile = /(^|\/)(\.env|\.env\.local|\.env\.production|credentials\.json|service-account.*\.json)$/i;
const forbiddenRepositoryPath = /^(\.git|\.github)(\/|$)/i;
const maxBundleBytes = 2_000_000;

function safePath(input: string) {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe repair path: ${input}`);
  }
  if (forbiddenSecretFile.test(normalized) || forbiddenRepositoryPath.test(normalized)) {
    throw new Error(`Repair attempted forbidden path: ${normalized}`);
  }
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
    if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,current_version_id,blueprint")
      .eq("id", body.projectId)
      .single();
    if (projectError || !project?.current_version_id) return NextResponse.json({ error: "No generated version to repair" }, { status: 409 });

    const { data: currentFiles, error: fileError } = await supabase
      .from("generated_files")
      .select("path,content")
      .eq("version_id", project.current_version_id)
      .order("path");
    if (fileError) throw new Error(fileError.message);
    if (!currentFiles?.length) throw new Error("Current version has no files");

    const model = getCodeModel();

    const { data: run, error: runError } = await supabase
      .from("ai_runs")
      .insert({ project_id: body.projectId, user_id: authData.user.id, run_type: "repair", model, status: "running" })
      .select("id")
      .single();
    if (runError) throw new Error(runError.message);
    runId = run?.id ?? null;

    const source = currentFiles.map((file) => `--- ${file.path} ---\n${file.content}`).join("\n\n");
    const client = createAIClient();
    const response = await client.responses.parse({
      model,
      input: [
        { role: "system", content: REPAIR_SYSTEM_PROMPT },
        {
          role: "user",
          content: `BLUEPRINT:\n${JSON.stringify(project.blueprint ?? {}, null, 2)}\n\nSANDBOX LOGS:\n${body.logs}\n\nCURRENT SOURCE TREE:\n${source}`,
        },
      ],
      text: { format: zodTextFormat(repairPatchSchema, "repair_patch") },
    });

    const patch = response.output_parsed;
    if (!patch) throw new Error("Repair model returned no patch");

    const next = new Map(currentFiles.map((file) => [safePath(file.path), file.content]));
    for (const deleted of patch.deletes) next.delete(safePath(deleted));
    for (const file of patch.upserts) next.set(safePath(file.path), file.content);

    let bundleBytes = 0;
    const files = [...next.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, content]) => {
      bundleBytes += Buffer.byteLength(content, "utf8");
      if (bundleBytes > maxBundleBytes) throw new Error("Repaired application exceeds the 2 MB source bundle limit");
      return { path: filePath, content, content_hash: createHash("sha256").update(content, "utf8").digest("hex") };
    });

    const { data: version, error: commitError } = await supabase.rpc("commit_project_generation", {
      p_project_id: body.projectId,
      p_summary: `Repair: ${patch.summary}`,
      p_files: files,
    });
    if (commitError || !version) throw new Error(commitError?.message || "Could not commit repaired application");
    const versionRow = Array.isArray(version) ? version[0] : version;

    if (runId) {
      await supabase.from("ai_runs").update({
        status: "succeeded",
        input_tokens: response.usage?.input_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
      }).eq("id", runId);
    }

    await supabase.from("messages").insert({
      project_id: body.projectId,
      user_id: authData.user.id,
      role: "assistant",
      content: `Auto-repair created version ${versionRow.version_number}: ${patch.summary}`,
      metadata: { versionId: versionRow.id, repair: true, upserts: patch.upserts.length, deletes: patch.deletes.length },
    });

    return NextResponse.json({ version: { id: versionRow.id, number: versionRow.version_number }, summary: patch.summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Repair failed";
    if (runId) await supabase.from("ai_runs").update({ status: "failed", error_message: message }).eq("id", runId);
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid repair request", details: error.issues }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
