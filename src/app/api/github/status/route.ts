import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: project } = await supabase
    .from("projects")
    .select("id,github_repo_full_name,github_default_branch,github_last_synced_sha,github_sync_status,github_sync_error")
    .eq("id", projectId)
    .single();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data: connection } = await admin
    .from("github_connections")
    .select("github_login,installation_id,status")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({
    connected: Boolean(connection && connection.status === "installed" && connection.installation_id),
    githubLogin: connection?.github_login ?? null,
    installationId: connection?.installation_id ?? null,
    repoFullName: project.github_repo_full_name,
    branch: project.github_default_branch,
    lastSyncedSha: project.github_last_synced_sha,
    syncStatus: project.github_sync_status,
    syncError: project.github_sync_error,
  });
}
