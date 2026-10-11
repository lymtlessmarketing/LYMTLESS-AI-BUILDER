import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ARCHITECT_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";
import { appBlueprintSchema } from "@/lib/ai/schemas";
import { createClient } from "@/lib/supabase/server";

const requestSchema = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().trim().min(10).max(20_000),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const supabase = await createClient();
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

    await supabase.from("messages").insert({
      project_id: body.projectId,
      user_id: user.id,
      role: "user",
      content: body.prompt,
    });

    const { data: run } = await supabase
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
    if (!blueprint) {
      if (run?.id) {
        await supabase
          .from("ai_runs")
          .update({ status: "failed", error_message: "Model returned no parsed blueprint" })
          .eq("id", run.id);
      }
      return NextResponse.json({ error: "AI did not return a valid application blueprint" }, { status: 502 });
    }

    await Promise.all([
      supabase.from("messages").insert({
        project_id: body.projectId,
        user_id: user.id,
        role: "assistant",
        content: `Created architecture blueprint for ${blueprint.name}.`,
        metadata: { blueprint },
      }),
      supabase.from("projects").update({
        name: blueprint.name,
        description: blueprint.summary,
        status: "planned",
      }).eq("id", body.projectId),
      ...(run?.id
        ? [supabase.from("ai_runs").update({
            status: "succeeded",
            input_tokens: response.usage?.input_tokens ?? null,
            output_tokens: response.usage?.output_tokens ?? null,
          }).eq("id", run.id)]
        : []),
    ]);

    return NextResponse.json({ blueprint });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request", details: error.issues }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Unable to create application plan" }, { status: 500 });
  }
}
