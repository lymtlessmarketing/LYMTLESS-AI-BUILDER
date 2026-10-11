import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createHostingProject,
  createProductionDeployment,
  uploadDeploymentFiles,
  vercelPlatformConfigured,
  waitForDeployment,
  type VercelProject,
} from "@/lib/vercel/platform";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });

export async function POST(request: Request) {
  const supabase = await createClient();
  let deploymentRowId: string | null = null;

  try {
    if (!vercelPlatformConfigured()) {
      return NextResponse.json({ error: "Production deployment is not configured", setup: "Set VERCEL_TOKEN and VERCEL_TEAM_ID on the builder server." }, { status: 503 });
    }

    const { projectId } = requestSchema.parse(await request.json());
    const { data: authData } = await supabase.auth.getUser();
    const user = authData.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,name,current_version_id,production_url")
      .eq("id", projectId)
      .single();
    if (projectError || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.current_version_id) return NextResponse.json({ error: "No application version is ready to publish" }, { status: 409 });

    const { data: version, error: versionError } = await supabase
      .from("versions")
      .select("id,status,version_number")
      .eq("id", project.current_version_id)
      .single();
    if (versionError || !version) return NextResponse.json({ error: "Current application version was not found" }, { status: 409 });
    if (version.status !== "tested" && version.status !== "deployed") {
      return NextResponse.json({ error: "Only a QA-tested application version can be published" }, { status: 409 });
    }

    const { data: sourceFiles, error: filesError } = await supabase
      .from("generated_files")
      .select("path,content")
      .eq("version_id", version.id)
      .order("path", { ascending: true });
    if (filesError) throw new Error(filesError.message);
    if (!sourceFiles?.length) return NextResponse.json({ error: "Current version has no deployment source files" }, { status: 409 });

    let hostingProject = await loadHostingProject(supabase, projectId);
    if (!hostingProject) {
      const { data: backend } = await supabase
        .from("app_backends")
        .select("status,api_url,publishable_key")
        .eq("project_id", projectId)
        .maybeSingle();
      const env = backend?.status === "ready" && backend.api_url && backend.publishable_key
        ? {
            VITE_SUPABASE_URL: String(backend.api_url),
            VITE_SUPABASE_PUBLISHABLE_KEY: String(backend.publishable_key),
          }
        : {};

      const providerProject = await createHostingProject(projectName(project.name, projectId), env);
      const { data: createdHosting, error: hostingError } = await supabase
        .from("hosting_projects")
        .insert({
          project_id: projectId,
          user_id: user.id,
          provider: "vercel",
          provider_project_id: providerProject.id,
          provider_project_name: providerProject.name,
        })
        .select("provider_project_id,provider_project_name")
        .single();
      if (hostingError || !createdHosting) throw new Error(hostingError?.message || "Could not save hosting project");
      hostingProject = createdHosting;
    }

    const { data: deploymentRow, error: deploymentInsertError } = await supabase
      .from("deployments")
      .insert({
        project_id: projectId,
        version_id: version.id,
        environment: "production",
        provider: "vercel",
        status: "queued",
      })
      .select("id")
      .single();
    if (deploymentInsertError || !deploymentRow) throw new Error(deploymentInsertError?.message || "Could not create deployment record");
    deploymentRowId = deploymentRow.id;

    const uploaded = await uploadDeploymentFiles(sourceFiles);
    await supabase.from("deployments").update({ status: "building" }).eq("id", deploymentRowId);

    const created = await createProductionDeployment({
      project: {
        id: hostingProject.provider_project_id,
        name: hostingProject.provider_project_name,
      },
      files: uploaded,
    });
    await supabase.from("deployments").update({ provider_deployment_id: created.id }).eq("id", deploymentRowId);

    const ready = await waitForDeployment(created.id);
    const productionUrl = canonicalDeploymentUrl(ready);

    const writes = await Promise.all([
      supabase.from("deployments").update({ status: "ready", url: productionUrl }).eq("id", deploymentRowId),
      supabase.from("versions").update({ status: "deployed" }).eq("id", version.id),
      supabase.from("projects").update({ production_url: productionUrl, status: "ready" }).eq("id", projectId),
    ]);
    const writeError = writes.find((result) => result.error)?.error;
    if (writeError) throw new Error(writeError.message);

    return NextResponse.json({
      deploymentId: created.id,
      deploymentRecordId: deploymentRowId,
      versionId: version.id,
      versionNumber: version.version_number,
      productionUrl,
      hostingProject: hostingProject.provider_project_name,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Production deployment failed";
    if (deploymentRowId) await supabase.from("deployments").update({ status: "failed" }).eq("id", deploymentRowId);
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid publish request" }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

async function loadHostingProject(supabase: Awaited<ReturnType<typeof createClient>>, projectId: string) {
  const { data, error } = await supabase
    .from("hosting_projects")
    .select("provider_project_id,provider_project_name")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function projectName(name: string, projectId: string) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "lymtless-app";
  return `${base}-${projectId.slice(0, 8)}`.slice(0, 90);
}

function canonicalDeploymentUrl(deployment: { url?: string; alias?: string[] }) {
  const host = deployment.alias?.[0] || deployment.url;
  if (!host) throw new Error("Vercel deployment became ready without a public URL");
  return `https://${host.replace(/^https?:\/\//, "")}`;
}
