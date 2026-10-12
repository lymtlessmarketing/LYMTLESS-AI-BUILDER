import { zodTextFormat } from "openai/helpers/zod";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAIClient, getPlanningModel } from "@/lib/ai/client";
import { ARCHITECT_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { appBlueprintSchema } from "@/lib/ai/schemas";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export const MAX_BUILD_PROMPT_CHARS = 120_000;

const requestSchema = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().trim().min(10).max(MAX_BUILD_PROMPT_CHARS),
});

function requestError(error: z.ZodError) {
  const promptIssue = error.issues.find((issue) => issue.path[0] === "prompt");
  if (promptIssue?.code === "too_big") {
    return NextResponse.json(
      {
        error: `Prompt is too long. Maximum ${MAX_BUILD_PROMPT_CHARS.toLocaleString()} characters.`,
        code: "PROMPT_TOO_LONG",
        maxCharacters: MAX_BUILD_PROMPT_CHARS,
      },
      { status: 413 },
    );
  }

  if (promptIssue?.code === "too_small") {
    return NextResponse.json(
      { error: "Describe the application in at least 10 characters.", code: "PROMPT_TOO_SHORT" },
      { status: 400 },
    );
  }

  return NextResponse.json(
    { error: "The build request is invalid.", code: "INVALID_BUILD_REQUEST", details: error.issues },
    { status: 400 },
  );
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
      .select("id,name")
      .eq("id", body.projectId)
      .single();

    if (projectError || !project) {
      return NextResponse.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
    }

    const model = getPlanningModel();

    const { error: userMessageError } = await supabase.from("messages").insert({
      project_id: body.projectId,
      user_id: user.id,
      role: "user",
      content: body.prompt,
    });
    if (userMessageError) console.warn("User message audit write failed:", userMessageError.message);

    const { data: run, error: runError } = await supabase
      .from("ai_runs")
      .insert({
        project_id: body.projectId,
        user_id: user.id,
        run_type: "plan",
        model,
        status: "running",
      })
      .select("id")
      .single();
    if (runError) console.warn("AI run audit creation failed:", runError.message);
    runId = run?.id ?? null;

    const client = createAIClient();
    const response = await client.responses.parse({
      model,
      input: [
        { role: "system", content: ARCHITECT_SYSTEM_PROMPT },
        { role: "user", content: body.prompt },
      ],
      text: {
        format: zodTextFormat(appBlueprintSchema, "application_blueprint"),
      },
    });

    const blueprint = response.output_parsed;
    if (!blueprint) throw new Error("The architecture model returned no valid application blueprint.");

    const { error: projectUpdateError } = await supabase.from("projects").update({
      name: blueprint.name.slice(0, 120),
      description: blueprint.summary,
      blueprint,
      status: "planned",
    }).eq("id", body.projectId);
    if (projectUpdateError) throw new Error(projectUpdateError.message);

    const auditResults = await Promise.all([
      supabase.from("messages").insert({
        project_id: body.projectId,
        user_id: user.id,
        role: "assistant",
        content: `Created architecture blueprint for ${blueprint.name}.`,
        metadata: { blueprint },
      }),
      runId
        ? supabase.from("ai_runs").update({
            status: "succeeded",
            input_tokens: response.usage?.input_tokens ?? null,
            output_tokens: response.usage?.output_tokens ?? null,
          }).eq("id", runId)
        : Promise.resolve({ error: null }),
    ]);
    auditResults.forEach((result) => {
      if (result.error) console.warn("Planning audit write failed:", result.error.message);
    });

    return NextResponse.json({ blueprint, promptCharacters: body.prompt.length });
  } catch (error) {
    if (error instanceof z.ZodError) return requestError(error);

    const message = error instanceof Error ? error.message : "Unable to create application plan";
    if (runId) await supabase.from("ai_runs").update({ status: "failed", error_message: message }).eq("id", runId);
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    console.error("Planning failed:", error);
    return NextResponse.json({ error: message, code: "PLANNING_FAILED" }, { status: 500 });
  }
}
