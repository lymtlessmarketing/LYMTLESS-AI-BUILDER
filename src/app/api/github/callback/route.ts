import { NextResponse } from "next/server";
import {
  exchangeGithubCode,
  getGithubUser,
  listGithubInstallations,
  saveGithubConnection,
  selectInstallation,
} from "@/lib/github/client";
import { verifyGithubState } from "@/lib/github/security";
import { syncProjectToGithub } from "@/lib/github/sync";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const stateValue = requestUrl.searchParams.get("state");
  if (!code || !stateValue) return NextResponse.redirect(new URL("/?github=invalid_callback", requestUrl.origin));

  let state: ReturnType<typeof verifyGithubState>;
  try {
    state = verifyGithubState(stateValue);
  } catch {
    return NextResponse.redirect(new URL("/?github=invalid_state", requestUrl.origin));
  }

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user || user.id !== state.userId) {
    return NextResponse.redirect(new URL(`/login?next=/builder/${state.projectId}`, requestUrl.origin));
  }

  const callbackUrl = `${requestUrl.origin}/api/github/callback`;
  try {
    const token = await exchangeGithubCode(code, callbackUrl);
    const githubUser = await getGithubUser(token.access_token);
    const installations = await listGithubInstallations(token.access_token);
    const installation = selectInstallation(installations, githubUser);
    await saveGithubConnection({ userId: user.id, githubUser, installation, token });

    if (!installation) {
      return NextResponse.redirect(new URL(`/builder/${state.projectId}?github=installation_required`, requestUrl.origin));
    }

    try {
      await syncProjectToGithub(state.projectId, user.id);
      return NextResponse.redirect(new URL(`/builder/${state.projectId}?github=synced`, requestUrl.origin));
    } catch (syncError) {
      console.error("Initial GitHub sync failed", syncError);
      return NextResponse.redirect(new URL(`/builder/${state.projectId}?github=connected_sync_failed`, requestUrl.origin));
    }
  } catch (error) {
    console.error("GitHub callback failed", error);
    return NextResponse.redirect(new URL(`/builder/${state.projectId}?github=failed`, requestUrl.origin));
  }
}
