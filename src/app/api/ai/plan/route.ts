import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ARCHITECT_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { appBlueprintSchema } from "@/lib/ai/schemas";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const requestSchema = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().trim().min(10).max(20_000),
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
      .select("id,name")
      .eq("id", body.projectId)
      .single();

    if (projectError || !project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 503 });

    const model = process.env.OPENAI_MODEL || "gpt-6.1-sol";

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

    const client = new OpenAI({ apiKey });
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
    if (!blueprint) throw new Error("AI did not return a valid application blueprint");

    const { error: projectUpdateError } = await supabase.from("projects").update({
      name: blueprint.name,
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

    return NextResponse.json({ blueprint });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create application plan";
    if (runId) await supabase.from("ai_runs").update({ status: "failed", error_message: message }).eq("id", runId);
    if (projectId) await supabase.from("projects").update({ status: "failed" }).eq("id", projectId);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request", details: error.issues }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
