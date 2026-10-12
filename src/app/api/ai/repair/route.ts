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
export const maxDuration = 300;

const requestSchema = z.object({
  projectId: z.string().uuid(),
  logs: z.string().min(1).max(24_000),
});
const forbiddenSecretFile = /(^|\/)(\.env|\.env\.local|\.env\.production|credentials\.json|service-account.*\.json)$/i;
const forbiddenRepositoryPath = /^(\.git|\.github)(\/|$)/i;
const maxBundleBytes = 3_000_000;
const maxRepairSourceChars = 500_000;

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

function buildRepairSource(files: Array<{ path: string; content: string }>, logs: string) {
  const normalizedLogs = logs.toLowerCase();
  const priorityNames = new Set([
    "package.json",
    "tsconfig.json",
    "tsconfig.app.json",
    "vite.config.ts",
    "vite.config.js",
    "src/main.tsx",
    "src/main.ts",
    "src/app.tsx",
    "src/app.ts",
  ]);

  const scored = files.map((file) => {
    const filePath = safePath(file.path);
    const lowerPath = filePath.toLowerCase();
    const base = path.posix.basename(lowerPath);
    let score = priorityNames.has(lowerPath) ? 100 : 0;
    if (normalizedLogs.includes(lowerPath)) score += 80;
    if (base.length > 3 && normalizedLogs.includes(base)) score += 40;
    if (lowerPath.startsWith("src/")) score += 10;
    return { ...file, path: filePath, score };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const chunks: string[] = [];
  let total = 0;
  for (const file of scored) {
    const chunk = `--- ${file.path} ---\n${file.content}\n`;
    if (total + chunk.length > maxRepairSourceChars) continue;
    chunks.push(chunk);
    total += chunk.length;
  }

  if (chunks.length === 0) throw new Error("No source files fit within the repair context window");
  return chunks.join("\n");
}

export async function POST(request: Request) {
  const supabase = await createClient();
  let runId: string | null = null;
  let projectId: string | null = null;

  try {
    const body = requestSchema.parse(await request.json());
    projectId = body.projectId;
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,current_version_id,blueprint")
      .eq("id", body.projectId)
      .single();
    if (projectError || !project?.current_version_id) {
      return NextResponse.json({ error: "No generated version to repair", code: "VERSION_REQUIRED" }, { status: 409 });
    }

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

    const source = buildRepairSource(currentFiles, body.logs);
    const client = createAIClient(request.headers.get("x-vercel-oidc-token"));
    const response = await client.responses.parse({
      model,
      input: [
        { role: "system", content: REPAIR_SYSTEM_PROMPT },
        {
          role: "user",
          content: `BLUEPRINT:\n${JSON.stringify(project.blueprint ?? {}, null, 2)}\n\nSANDBOX LOGS:\n${body.logs}\n\nRELEVANT SOURCE TREE:\n${source}`,
        },
      ],
      text: { format: zodTextFormat(repairPatchSchema, "repair_patch") },
    });

    const patch = response.output_parsed;
    if (!patch) throw new Error("Repair model returned no valid patch");
    if (!patch.upserts.length && !patch.deletes.length) throw new Error("Repair model returned an empty patch");

    const next = new Map(currentFiles.map((file) => [safePath(file.path), file.content]));
    for (const deleted of patch.deletes) next.delete(safePath(deleted));
    for (const file of patch.upserts) next.set(safePath(file.path), file.content);

    if (!next.has("package.json")) throw new Error("Repair removed required package.json");

    let bundleBytes = 0;
    const files = [...next.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, content]) => {
      bundleBytes += Buffer.byteLength(content, "utf8");
      if (bundleBytes > maxBundleBytes) throw new Error("Repaired application exceeds the 3 MB source bundle limit");
      return { path: filePath, content, content_hash: createHash("sha256").update(content, "utf8").digest("hex") };
    });

    const { data: version, error: commitError } = await supabase.rpc("commit_project_generation", {
      p_project_id: body.projectId,
      p_summary: `Repair: ${patch.summary}`,
      p_files: files,
    });
    if (commitError || !version) throw new Error(commitError?.message || "Could not commit repaired application");
    const versionRow = Array.isArray(version) ? version[0] : version;
    if (!versionRow?.id) throw new Error("Repair commit returned no version id");

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
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid repair request", code: "INVALID_REPAIR_REQUEST", details: error.issues }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Repair failed";
    if (runId) await supabase.from("ai_runs").update({ status: "failed", error_message: message }).eq("id", runId);
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    console.error("Repair failed:", error);
    return NextResponse.json({ error: message, code: "REPAIR_FAILED" }, { status: 500 });
  }
}
