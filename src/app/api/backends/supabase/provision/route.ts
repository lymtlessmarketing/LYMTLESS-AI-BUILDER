import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createPlatformProject,
  ensurePublishableKey,
  findPlatformProjectByName,
  managementConfigured,
  platformOrganizationSlug,
  waitForProjectHealthy,
} from "@/lib/supabase/management";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({ projectId: z.string().uuid() });
const STALE_PROVISIONING_MS = 5 * 60 * 1000;

export async function POST(request: Request) {
  const supabase = await createClient();
  let backendId: string | null = null;
  let transientDatabasePassword: string | null = null;

  try {
    const { projectId } = requestSchema.parse(await request.json());
    const { data: authData } = await supabase.auth.getUser();
    const user = authData.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!managementConfigured()) {
      return NextResponse.json(
        { error: "Supabase platform provisioning is not configured", setup: "Set SUPABASE_MANAGEMENT_TOKEN and SUPABASE_PLATFORM_ORG_SLUG on the LYMTLESS builder server." },
        { status: 503 },
      );
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,name")
      .eq("id", projectId)
      .single();
    if (projectError || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    let { data: backend } = await supabase
      .from("app_backends")
      .select("id,status,external_project_ref,api_url,publishable_key,region,updated_at")
      .eq("project_id", projectId)
      .maybeSingle();

    if (backend?.status === "ready" && backend.external_project_ref && backend.api_url && backend.publishable_key) {
      return NextResponse.json({ backend: publicBackend(backend), reused: true });
    }

    if (!backend) {
      const maxBackends = parsePositiveInt(process.env.SUPABASE_MAX_BACKENDS_PER_USER, 3);
      const { count } = await supabase
        .from("app_backends")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);
      if ((count ?? 0) >= maxBackends) {
        return NextResponse.json({ error: `Backend quota reached (${maxBackends} per user)` }, { status: 429 });
      }

      const { data: inserted, error: insertError } = await supabase
        .from("app_backends")
        .insert({ project_id: projectId, user_id: user.id, status: "queued", organization_slug: platformOrganizationSlug() })
        .select("id,status,external_project_ref,api_url,publishable_key,region,updated_at")
        .single();
      if (insertError || !inserted) {
        const { data: raced } = await supabase
          .from("app_backends")
          .select("id,status,external_project_ref,api_url,publishable_key,region,updated_at")
          .eq("project_id", projectId)
          .maybeSingle();
        if (!raced) throw new Error(insertError?.message || "Could not create backend record");
        backend = raced;
      } else {
        backend = inserted;
      }
    }

    backendId = backend.id;
    let ref = backend.external_project_ref as string | null;
    const externalName = backendProjectName(project.name, projectId);

    if (!ref) {
      const staleProvision = backend.status === "provisioning" && isOlderThan(backend.updated_at, STALE_PROVISIONING_MS);

      if (staleProvision) {
        const recovered = await findPlatformProjectByName(externalName);
        const recoveredRef = recovered?.ref || recovered?.id || null;
        if (recoveredRef) {
          ref = recoveredRef;
          const { error: recoveryError } = await supabase
            .from("app_backends")
            .update({
              external_project_ref: ref,
              region: recovered?.region || backend.region || process.env.SUPABASE_SMART_REGION || "americas",
              status: "provisioning",
              error_message: null,
            })
            .eq("id", backend.id);
          if (recoveryError) throw new Error(recoveryError.message);
        }
      }

      if (!ref) {
        const claimable = backend.status === "queued" || backend.status === "failed" || staleProvision;
        if (!claimable) {
          return NextResponse.json({ backend: { id: backend.id, status: "provisioning" }, inProgress: true }, { status: 202 });
        }

        const claimQuery = supabase
          .from("app_backends")
          .update({ status: "provisioning", error_message: null })
          .eq("id", backend.id)
          .eq("status", backend.status);
        if (backend.updated_at) claimQuery.eq("updated_at", backend.updated_at);

        const { data: claimed, error: claimError } = await claimQuery.select("id").maybeSingle();
        if (claimError) throw new Error(claimError.message);
        if (!claimed) {
          return NextResponse.json({ backend: { id: backend.id, status: "provisioning" }, inProgress: true }, { status: 202 });
        }

        transientDatabasePassword = generateDatabasePassword();
        const external = await createPlatformProject({
          name: externalName,
          dbPassword: transientDatabasePassword,
        });
        transientDatabasePassword = null;

        ref = external.ref || external.id || null;
        if (!ref) throw new Error("Supabase create-project response did not include a project ref");

        const { error: persistRefError } = await supabase
          .from("app_backends")
          .update({
            external_project_ref: ref,
            region: external.region || process.env.SUPABASE_SMART_REGION || "americas",
            status: "provisioning",
          })
          .eq("id", backend.id);
        if (persistRefError) throw new Error(persistRefError.message);
      }
    } else {
      await supabase.from("app_backends").update({ status: "provisioning", error_message: null }).eq("id", backend.id);
    }

    await waitForProjectHealthy(ref);
    await supabase.from("app_backends").update({ status: "healthy" }).eq("id", backend.id);

    const publishableKey = await ensurePublishableKey(ref);
    const apiUrl = `https://${ref}.supabase.co`;

    const { data: ready, error: readyError } = await supabase
      .from("app_backends")
      .update({ status: "ready", api_url: apiUrl, publishable_key: publishableKey, error_message: null })
      .eq("id", backend.id)
      .select("id,status,external_project_ref,api_url,publishable_key,region")
      .single();
    if (readyError || !ready) throw new Error(readyError?.message || "Could not finalize backend record");

    return NextResponse.json({ backend: publicBackend(ready), reused: Boolean(backend.external_project_ref) });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "Backend provisioning failed";
    const message = redactSecret(rawMessage, transientDatabasePassword);
    if (backendId) await supabase.from("app_backends").update({ status: "failed", error_message: clip(message) }).eq("id", backendId);
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid backend request" }, { status: 400 });
    console.error(message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function publicBackend(backend: Record<string, unknown>) {
  return {
    id: backend.id,
    status: backend.status,
    projectRef: backend.external_project_ref,
    apiUrl: backend.api_url,
    publishableKey: backend.publishable_key,
    region: backend.region,
  };
}

function generateDatabasePassword() {
  return `${randomBytes(30).toString("base64url")}Aa1!`;
}

function backendProjectName(name: string, projectId: string) {
  const clean = name.replace(/[^a-zA-Z0-9 _-]+/g, "").trim() || "LYMTLESS App";
  return `${clean} ${projectId.slice(0, 8)}`.slice(0, 80);
}

function isOlderThan(timestamp: unknown, ageMs: number) {
  if (typeof timestamp !== "string") return false;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && Date.now() - value >= ageMs;
}

function redactSecret(value: string, secret: string | null) {
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clip(value: string) {
  return value.length > 10_000 ? `${value.slice(0, 10_000)}…` : value;
}
