import { NextResponse } from "next/server";
import { createGithubState } from "@/lib/github/security";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return NextResponse.redirect(new URL("/login", url.origin));

  const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).single();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return NextResponse.json({ error: "GITHUB_APP_SLUG is not configured" }, { status: 503 });

  const state = createGithubState(user.id, projectId);
  const installUrl = new URL(`https://github.com/apps/${slug}/installations/new`);
  installUrl.searchParams.set("state", state);
  return NextResponse.redirect(installUrl);
}
