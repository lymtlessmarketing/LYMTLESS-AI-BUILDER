import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const querySchema = z.object({ projectId: z.string().uuid() });

export async function GET(request: Request) {
  const supabase = await createClient();
  try {
    const url = new URL(request.url);
    const { projectId } = querySchema.parse({ projectId: url.searchParams.get("projectId") });
    const user = (await supabase.auth.getUser()).data.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,production_url,current_version_id")
      .eq("id", projectId)
      .single();
    if (projectError || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const [{ data: hosting }, { data: domains }, { data: latestDeployment }, { data: currentVersion }] = await Promise.all([
      supabase.from("hosting_projects").select("provider,provider_project_id,provider_project_name").eq("project_id", projectId).maybeSingle(),
      supabase.from("project_domains").select("id,domain,status,verified,verification,dns_config,error_message").eq("project_id", projectId).order("created_at", { ascending: true }),
      supabase.from("deployments").select("id,version_id,provider_deployment_id,url,status,created_at").eq("project_id", projectId).eq("environment", "production").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      project.current_version_id
        ? supabase.from("versions").select("id,status,version_number").eq("id", project.current_version_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    return NextResponse.json({
      productionUrl: project.production_url,
      currentVersionId: project.current_version_id,
      currentVersion: currentVersion || null,
      hosting: hosting || null,
      latestDeployment: latestDeployment || null,
      domains: domains || [],
    });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid deployment status request" }, { status: 400 });
    const message = error instanceof Error ? error.message : "Could not load deployment status";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
