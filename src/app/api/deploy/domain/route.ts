import { NextResponse } from "next/server";
import { z } from "zod";
import {
  addProjectDomain,
  getDomainConfig,
  getProjectDomain,
  verifyProjectDomain,
  vercelPlatformConfigured,
} from "@/lib/vercel/platform";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const domainSchema = z.string().trim().toLowerCase().min(3).max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const postSchema = z.object({ projectId: z.string().uuid(), domain: domainSchema });
const getSchema = z.object({ projectId: z.string().uuid(), domain: domainSchema });

export async function POST(request: Request) {
  const supabase = await createClient();
  try {
    if (!vercelPlatformConfigured()) return NextResponse.json({ error: "Vercel production deployment is not configured" }, { status: 503 });
    const body = postSchema.parse(await request.json());
    const user = (await supabase.auth.getUser()).data.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const hosting = await getHostingProject(supabase, body.projectId);
    if (!hosting) return NextResponse.json({ error: "Publish the application before adding a custom domain" }, { status: 409 });

    let attached;
    try {
      attached = await addProjectDomain(hosting.provider_project_id, body.domain);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add custom domain";
      if (!/already exists|already been assigned|domain.*exists/i.test(message)) throw error;
      attached = await getProjectDomain(hosting.provider_project_id, body.domain);
    }

    if (attached.verified === false && attached.verification?.length) {
      try { attached = await verifyProjectDomain(hosting.provider_project_id, body.domain); } catch { /* verification may require user DNS changes */ }
    }

    const config = await getDomainConfig(body.domain);
    const status = domainStatus(attached, config);
    const { data, error } = await supabase
      .from("project_domains")
      .upsert({
        project_id: body.projectId,
        user_id: user.id,
        hosting_project_id: hosting.id,
        domain: body.domain,
        status,
        verified: attached.verified === true,
        verification: attached.verification || [],
        dns_config: boundedJson(config),
        error_message: null,
      }, { onConflict: "project_id,domain" })
      .select("id,domain,status,verified,verification,dns_config")
      .single();
    if (error) throw new Error(error.message);

    return NextResponse.json({ domain: data, instructions: dnsInstructions(body.domain, attached, config) });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Enter a valid domain such as app.example.com" }, { status: 400 });
    const message = error instanceof Error ? error.message : "Custom domain setup failed";
    console.error(error);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

export async function GET(request: Request) {
  const supabase = await createClient();
  try {
    const url = new URL(request.url);
    const query = getSchema.parse({ projectId: url.searchParams.get("projectId"), domain: url.searchParams.get("domain") });
    const user = (await supabase.auth.getUser()).data.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const hosting = await getHostingProject(supabase, query.projectId);
    if (!hosting) return NextResponse.json({ error: "Hosting project not found" }, { status: 404 });
    const attached = await getProjectDomain(hosting.provider_project_id, query.domain);
    const config = await getDomainConfig(query.domain);
    const status = domainStatus(attached, config);

    const { data, error } = await supabase
      .from("project_domains")
      .upsert({
        project_id: query.projectId,
        user_id: user.id,
        hosting_project_id: hosting.id,
        domain: query.domain,
        status,
        verified: attached.verified === true,
        verification: attached.verification || [],
        dns_config: boundedJson(config),
        error_message: null,
      }, { onConflict: "project_id,domain" })
      .select("id,domain,status,verified,verification,dns_config")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ domain: data, instructions: dnsInstructions(query.domain, attached, config) });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid domain status request" }, { status: 400 });
    const message = error instanceof Error ? error.message : "Could not refresh domain status";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

async function getHostingProject(supabase: Awaited<ReturnType<typeof createClient>>, projectId: string) {
  const { data, error } = await supabase
    .from("hosting_projects")
    .select("id,provider_project_id")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function domainStatus(domain: { verified?: boolean; verification?: unknown[] }, config: Record<string, unknown>) {
  if (domain.verified === false && domain.verification?.length) return "verification_required";
  if (config.misconfigured === true) return "misconfigured";
  return "ready";
}

function dnsInstructions(domain: string, attached: { verified?: boolean; verification?: Array<{ type?: string; domain?: string; value?: string; reason?: string }> }, config: Record<string, unknown>) {
  const records: Array<{ type: string; name: string; value: string; purpose: string }> = [];
  for (const challenge of attached.verification || []) {
    if (challenge.type && challenge.value) records.push({ type: challenge.type.toUpperCase(), name: challenge.domain || domain, value: challenge.value, purpose: "Domain ownership verification" });
  }

  if (config.misconfigured === true) {
    const cname = preferredCname(config) || "cname.vercel-dns-0.com";
    const ipv4 = preferredIpv4(config) || "76.76.21.21";
    const labels = domain.split(".");
    if (labels.length > 2) records.push({ type: "CNAME", name: domain, value: cname, purpose: "Route this subdomain to Vercel" });
    else records.push({ type: "A", name: "@", value: ipv4, purpose: "Route this apex domain to Vercel" });
  }
  return { status: domainStatus(attached, config), records };
}

function preferredCname(config: Record<string, unknown>) {
  const values = Array.isArray(config.recommendedCNAME) ? config.recommendedCNAME : [];
  const ranked = values
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    .sort((a, b) => Number(a.rank || 999) - Number(b.rank || 999));
  const preferred = ranked.find((entry) => typeof entry.value === "string")?.value;
  return typeof preferred === "string" ? preferred.replace(/\.$/, "") : null;
}

function preferredIpv4(config: Record<string, unknown>) {
  const values = Array.isArray(config.recommendedIPv4) ? config.recommendedIPv4 : [];
  const ranked = values
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    .sort((a, b) => Number(a.rank || 999) - Number(b.rank || 999));
  for (const entry of ranked) {
    if (Array.isArray(entry.value)) {
      const ip = entry.value.find((value): value is string => typeof value === "string");
      if (ip) return ip;
    }
  }
  return null;
}

function boundedJson(value: unknown) {
  const text = JSON.stringify(value);
  return text.length <= 25_000 ? value : { truncated: true, preview: `${text.slice(0, 24_500)}…` };
}
