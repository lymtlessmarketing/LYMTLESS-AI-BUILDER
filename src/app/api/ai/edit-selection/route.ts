import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { runTargetedEdit } from "@/lib/ai/targeted-edit";
import { safeSourcePath, type SourceFile } from "@/lib/sandbox/build";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_SOURCE_BYTES = 2_000_000;
const MAX_CHANGED_FILES = 12;

const targetSchema = z.object({
  tag: z.string().min(1).max(40),
  selector: z.string().min(1).max(1000),
  text: z.string().max(500),
  id: z.string().max(120).nullable().optional(),
  classes: z.array(z.string().max(80)).max(20),
  role: z.string().max(80).nullable().optional(),
  ariaLabel: z.string().max(160).nullable().optional(),
  name: z.string().max(120).nullable().optional(),
  inputType: z.string().max(40).nullable().optional(),
  sourceHint: z.string().max(240).nullable().optional(),
  route: z.string().min(1).max(300),
  ancestors: z.array(z.object({
    tag: z.string().min(1).max(40),
    id: z.string().max(120).nullable().optional(),
    classes: z.array(z.string().max(80)).max(12),
  })).max(6),
  rect: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  }).optional(),
});

const requestSchema = z.object({
  projectId: z.string().uuid(),
  versionId: z.string().uuid(),
  instruction: z.string().trim().min(2).max(4000),
  target: targetSchema,
});

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
      .select("id,current_version_id,blueprint")
      .eq("id", body.projectId)
      .single();
    if (projectError || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.current_version_id) return NextResponse.json({ error: "Generate and test an application before using Select & Edit" }, { status: 409 });
    if (project.current_version_id !== body.versionId) {
      return NextResponse.json({ error: "The preview is stale. Rebuild the latest version before editing this selection." }, { status: 409 });
    }

    const { data: rows, error: filesError } = await supabase
      .from("generated_files")
      .select("path,content,content_hash")
      .eq("version_id", body.versionId)
      .order("path", { ascending: true });
    if (filesError) throw new Error(filesError.message);
    if (!rows?.length) return NextResponse.json({ error: "Selected version has no source files" }, { status: 409 });

    const files: SourceFile[] = rows.map((file) => ({
      path: safeSourcePath(file.path),
      content: file.content,
      content_hash: file.content_hash,
    }));

    const model = process.env.OPENAI_EDIT_MODEL || process.env.OPENAI_CODE_MODEL || process.env.OPENAI_MODEL || "gpt-6.1-sol";
    const { data: run, error: runError } = await supabase
      .from("ai_runs")
      .insert({ project_id: body.projectId, user_id: user.id, run_type: "edit", model, status: "running" })
      .select("id")
      .single();
    if (runError) throw new Error(runError.message);
    runId = run?.id ?? null;

    const edit = await runTargetedEdit({
      files,
      blueprint: project.blueprint,
      target: body.target,
      instruction: body.instruction,
    });

    if (edit.patch.changes.length > MAX_CHANGED_FILES) {
      throw new Error(`Targeted edit attempted to change ${edit.patch.changes.length} files; the limit is ${MAX_CHANGED_FILES}`);
    }

    const byPath = new Map(files.map((file) => [file.path, file]));
    const changedPaths = new Set<string>();
    for (const change of edit.patch.changes) {
      const filePath = safeSourcePath(change.path);
      if (!isEditableUiPath(filePath)) throw new Error(`Select & Edit cannot modify non-UI file: ${filePath}`);
      if (!byPath.has(filePath)) throw new Error(`Select & Edit can only modify existing files: ${filePath}`);
      if (changedPaths.has(filePath)) throw new Error(`Targeted edit returned duplicate file: ${filePath}`);
      changedPaths.add(filePath);
      byPath.set(filePath, {
        path: filePath,
        content: change.content,
        content_hash: createHash("sha256").update(change.content, "utf8").digest("hex"),
      });
    }

    if (!changedPaths.size) throw new Error("Targeted edit returned no changes");
    const nextFiles = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
    const bytes = nextFiles.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
    if (bytes > MAX_SOURCE_BYTES) throw new Error("Edited application exceeds the 2 MB source bundle limit");

    const { data: version, error: versionError } = await supabase.rpc("commit_project_generation", {
      p_project_id: body.projectId,
      p_summary: `Select & Edit: ${edit.patch.summary}`,
      p_files: nextFiles.map((file) => ({
        path: file.path,
        content: file.content,
        content_hash: file.content_hash || createHash("sha256").update(file.content, "utf8").digest("hex"),
      })),
    });
    if (versionError || !version) throw new Error(versionError?.message || "Could not persist targeted edit version");

    const versionRow = Array.isArray(version) ? version[0] : version;
    if (!versionRow?.id) throw new Error("Targeted edit version returned no id");

    const auditWrites = await Promise.all([
      runId
        ? supabase.from("ai_runs").update({
            status: "succeeded",
            input_tokens: edit.inputTokens,
            output_tokens: edit.outputTokens,
          }).eq("id", runId)
        : Promise.resolve({ error: null }),
      supabase.from("messages").insert({
        project_id: body.projectId,
        user_id: user.id,
        role: "user",
        content: body.instruction,
        metadata: { kind: "select_edit", target: summarizeTarget(body.target), sourceVersionId: body.versionId },
      }),
      supabase.from("messages").insert({
        project_id: body.projectId,
        user_id: user.id,
        role: "assistant",
        content: `Select & Edit created version ${versionRow.version_number}: ${edit.patch.summary}`,
        metadata: { kind: "select_edit", versionId: versionRow.id, changedFiles: Array.from(changedPaths) },
      }),
    ]);
    auditWrites.forEach((result) => {
      if (result.error) console.warn("Select & Edit audit write failed:", result.error.message);
    });

    return NextResponse.json({
      version: {
        id: versionRow.id,
        number: versionRow.version_number,
        summary: edit.patch.summary,
      },
      changedFiles: Array.from(changedPaths),
      files: nextFiles.map((file) => file.path),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Select & Edit failed";
    if (runId) await supabase.from("ai_runs").update({ status: "failed", error_message: message.slice(0, 10_000) }).eq("id", runId);
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid Select & Edit request", details: error.issues }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

function isEditableUiPath(filePath: string) {
  return /^(src\/.*\.(?:tsx?|jsx?|css)|index\.html)$/.test(filePath) && !filePath.startsWith("src/server/");
}

function summarizeTarget(target: z.infer<typeof targetSchema>) {
  return {
    tag: target.tag,
    selector: target.selector,
    text: target.text.slice(0, 160),
    id: target.id ?? null,
    classes: target.classes.slice(0, 8),
    route: target.route,
    sourceHint: target.sourceHint ?? null,
  };
}
