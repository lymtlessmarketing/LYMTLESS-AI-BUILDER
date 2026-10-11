import { NextResponse } from "next/server";
import { importGithubCommit } from "@/lib/github/sync";
import { verifyWebhookSignature } from "@/lib/github/security";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  const eventName = request.headers.get("x-github-event") || "unknown";
  const deliveryId = request.headers.get("x-github-delivery");
  if (!deliveryId) return NextResponse.json({ error: "Missing GitHub delivery ID" }, { status: 400 });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid webhook JSON" }, { status: 400 });
  }

  const admin = createAdminClient();
  const repository = asRecord(payload.repository);
  const repoId = typeof repository?.id === "number" ? repository.id : null;
  const { error: deliveryError } = await admin.from("github_webhook_deliveries").insert({
    delivery_id: deliveryId,
    event_name: eventName,
    github_repo_id: repoId,
  });
  if (deliveryError?.code === "23505") return NextResponse.json({ ok: true, duplicate: true });
  if (deliveryError) return NextResponse.json({ error: "Could not record webhook delivery" }, { status: 500 });

  try {
    if (eventName === "github_app_authorization") {
      const action = typeof payload.action === "string" ? payload.action : "";
      const sender = asRecord(payload.sender);
      if (action === "revoked" && typeof sender?.id === "number") {
        await admin.from("github_connections").update({ status: "revoked", error_message: "GitHub App authorization revoked" }).eq("github_user_id", sender.id);
      }
      return NextResponse.json({ ok: true });
    }

    if (eventName === "installation") {
      const action = typeof payload.action === "string" ? payload.action : "";
      const installation = asRecord(payload.installation);
      if ((action === "deleted" || action === "suspend") && typeof installation?.id === "number") {
        await admin.from("github_connections").update({
          status: action === "deleted" ? "revoked" : "error",
          error_message: `GitHub App installation ${action}`,
        }).eq("installation_id", installation.id);
      }
      return NextResponse.json({ ok: true });
    }

    if (eventName !== "push") return NextResponse.json({ ok: true, ignored: eventName });
    if (!repoId || !repository) return NextResponse.json({ ok: true, ignored: "missing_repository" });

    const { data: project } = await admin
      .from("projects")
      .select("id,owner_id,github_repo_full_name,github_default_branch,github_last_synced_sha")
      .eq("github_repo_id", repoId)
      .maybeSingle();
    if (!project) return NextResponse.json({ ok: true, ignored: "untracked_repository" });

    const ref = typeof payload.ref === "string" ? payload.ref : "";
    const expectedRef = `refs/heads/${project.github_default_branch || "main"}`;
    if (ref !== expectedRef) return NextResponse.json({ ok: true, ignored: "non_default_branch" });
    if (payload.deleted === true) return NextResponse.json({ ok: true, ignored: "deleted_branch" });

    const after = typeof payload.after === "string" ? payload.after : "";
    if (!after || /^0+$/.test(after)) return NextResponse.json({ ok: true, ignored: "missing_commit" });

    const headCommit = asRecord(payload.head_commit);
    const message = typeof headCommit?.message === "string" ? headCommit.message : "";
    if (after === project.github_last_synced_sha || message.startsWith("[LYMTLESS]")) {
      await admin.from("projects").update({
        github_last_synced_sha: after,
        github_sync_status: "synced",
        github_sync_error: null,
      }).eq("id", project.id);
      return NextResponse.json({ ok: true, ignored: "builder_commit" });
    }

    await admin.from("projects").update({ github_sync_status: "syncing", github_sync_error: null }).eq("id", project.id);
    const result = await importGithubCommit({
      projectId: project.id,
      userId: project.owner_id,
      repoFullName: project.github_repo_full_name,
      commitSha: after,
    });
    return NextResponse.json({ ok: true, imported: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub webhook processing failed";
    if (repoId) {
      await admin.from("projects").update({ github_sync_status: "failed", github_sync_error: message.slice(0, 5000) }).eq("github_repo_id", repoId);
    }
    await admin.from("github_webhook_deliveries").delete().eq("delivery_id", deliveryId);
    console.error("GitHub webhook processing failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
