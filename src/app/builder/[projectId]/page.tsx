import { notFound, redirect } from "next/navigation";
import { BuilderWorkspace, type BuilderInitialState } from "@/components/builder-workspace";
import { appBlueprintSchema } from "@/lib/ai/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function BuilderPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login");

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id,name,description,status,blueprint,current_version_id,github_repo_full_name,production_url")
    .eq("id", projectId)
    .single();

  if (projectError || !project) notFound();

  const parsedBlueprint = project.blueprint ? appBlueprintSchema.safeParse(project.blueprint) : null;
  const blueprint = parsedBlueprint?.success ? parsedBlueprint.data : null;

  const [{ data: messageRows }, { data: deploymentRows }] = await Promise.all([
    supabase
      .from("messages")
      .select("role,content,created_at")
      .eq("project_id", projectId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("deployments")
      .select("url,provider_deployment_id,version_id,status,created_at")
      .eq("project_id", projectId)
      .eq("environment", "preview")
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  let generation: BuilderInitialState["generation"] = null;
  if (project.current_version_id) {
    const [{ data: version }, { data: files }] = await Promise.all([
      supabase
        .from("versions")
        .select("id,version_number,summary")
        .eq("id", project.current_version_id)
        .single(),
      supabase
        .from("generated_files")
        .select("path")
        .eq("version_id", project.current_version_id)
        .order("path"),
    ]);

    if (version) {
      generation = {
        version: {
          id: version.id,
          number: Number(version.version_number),
          summary: version.summary || "Generated application",
        },
        files: (files ?? []).map((file) => file.path),
      };
    }
  }

  const deployment = deploymentRows?.[0];
  const deploymentAge = deployment ? Date.now() - new Date(deployment.created_at).getTime() : Number.POSITIVE_INFINITY;
  const preview = deployment?.url && deployment.version_id === project.current_version_id && deploymentAge < 12 * 60 * 1000
    ? {
        previewUrl: deployment.url,
        sandboxName: deployment.provider_deployment_id || "sandbox",
        versionId: deployment.version_id,
      }
    : null;

  const initialState: BuilderInitialState = {
    project: {
      name: project.name,
      description: project.description,
      status: project.status,
      githubRepoFullName: project.github_repo_full_name,
      productionUrl: project.production_url,
    },
    blueprint,
    generation,
    preview,
    messages: (messageRows ?? []).map((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      text: message.content,
    })),
  };

  return <BuilderWorkspace projectId={projectId} initialState={initialState} />;
}
