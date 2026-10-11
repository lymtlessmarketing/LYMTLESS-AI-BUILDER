import { NextResponse } from "next/server";
import { z } from "zod";
import { syncProjectToGithub } from "@/lib/github/sync";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({ projectId: z.string().uuid() });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { projectId } = schema.parse(await request.json());
    const result = await syncProjectToGithub(projectId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid GitHub sync request" }, { status: 400 });
    const message = error instanceof Error ? error.message : "GitHub sync failed";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
