import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/github/security";
import { safeSourcePath, type SourceFile } from "@/lib/sandbox/build";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const MAX_IMPORT_FILES = 200;
const MAX_IMPORT_BYTES = 2_000_000;
const MAX_FILE_BYTES = 200_000;

type GithubTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

type GithubUser = { id: number; login: string };
type GithubInstallation = {
  id: number;
  account: { id: number; login: string; type: string };
  repository_selection: "all" | "selected";
};

type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
};

type StoredConnection = {
  user_id: string;
  github_user_id: number;
  github_login: string;
  access_token_ciphertext: string;
  access_token_iv: string;
  access_token_tag: string;
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  installation_id: number | null;
  status: string;
};

function githubHeaders(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "LYMTLESS-AI-BUILDER",
  };
}

async function githubFetch<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url.startsWith("http") ? url : `${API}${url}`, {
    ...init,
    headers: { ...githubHeaders(token), ...(init.headers || {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 2000)}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function exchangeGithubCode(code: string, redirectUri: string) {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GitHub App OAuth credentials are not configured");

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    cache: "no-store",
  });
  const data = (await response.json()) as GithubTokenResponse;
  if (!response.ok || !data.access_token || data.error) {
    throw new Error(data.error_description || data.error || "GitHub OAuth token exchange failed");
  }
  return data;
}

async function refreshGithubToken(refreshToken: string) {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GitHub App OAuth credentials are not configured");

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    cache: "no-store",
  });
  const data = (await response.json()) as GithubTokenResponse;
  if (!response.ok || !data.access_token || data.error) {
    throw new Error(data.error_description || data.error || "GitHub token refresh failed");
  }
  return data;
}

export async function getGithubUser(token: string) {
  return githubFetch<GithubUser>("/user", token);
}

export async function listGithubInstallations(token: string) {
  const data = await githubFetch<{ installations: GithubInstallation[] }>("/user/installations?per_page=100", token);
  return data.installations;
}

export async function saveGithubConnection(options: {
  userId: string;
  githubUser: GithubUser;
  installation: GithubInstallation | null;
  token: GithubTokenResponse;
}) {
  const admin = createAdminClient();
  const access = encryptSecret(options.token.access_token);
  const refresh = options.token.refresh_token ? encryptSecret(options.token.refresh_token) : null;
  const now = Date.now();
  const { error } = await admin.from("github_connections").upsert({
    user_id: options.userId,
    github_user_id: options.githubUser.id,
    github_login: options.githubUser.login,
    access_token_ciphertext: access.ciphertext,
    access_token_iv: access.iv,
    access_token_tag: access.tag,
    refresh_token_ciphertext: refresh?.ciphertext ?? null,
    refresh_token_iv: refresh?.iv ?? null,
    refresh_token_tag: refresh?.tag ?? null,
    access_token_expires_at: options.token.expires_in ? new Date(now + options.token.expires_in * 1000).toISOString() : null,
    refresh_token_expires_at: options.token.refresh_token_expires_in ? new Date(now + options.token.refresh_token_expires_in * 1000).toISOString() : null,
    installation_id: options.installation?.id ?? null,
    status: options.installation ? "installed" : "authorized",
    error_message: null,
  }, { onConflict: "user_id" });
  if (error) throw new Error(`Could not save GitHub connection: ${error.message}`);
}

export function selectInstallation(installations: GithubInstallation[], githubUser: GithubUser) {
  const personal = installations.find((installation) => installation.account.id === githubUser.id);
  if (personal) return personal;
  if (installations.length === 1) return installations[0];
  return null;
}

export async function getValidGithubConnection(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("github_connections")
    .select("*")
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error("GitHub is not connected for this user");
  const connection = data as StoredConnection;
  if (connection.status === "revoked") throw new Error("GitHub authorization was revoked; reconnect GitHub");

  let accessToken = decryptSecret({
    ciphertext: connection.access_token_ciphertext,
    iv: connection.access_token_iv,
    tag: connection.access_token_tag,
  });
  const expiresAt = connection.access_token_expires_at ? new Date(connection.access_token_expires_at).getTime() : null;

  if (expiresAt && expiresAt < Date.now() + 2 * 60 * 1000) {
    if (!connection.refresh_token_ciphertext || !connection.refresh_token_iv || !connection.refresh_token_tag) {
      throw new Error("GitHub authorization expired; reconnect GitHub");
    }
    if (connection.refresh_token_expires_at && new Date(connection.refresh_token_expires_at).getTime() < Date.now()) {
      throw new Error("GitHub refresh authorization expired; reconnect GitHub");
    }
    const refreshToken = decryptSecret({
      ciphertext: connection.refresh_token_ciphertext,
      iv: connection.refresh_token_iv,
      tag: connection.refresh_token_tag,
    });
    const refreshed = await refreshGithubToken(refreshToken);
    const access = encryptSecret(refreshed.access_token);
    const refresh = refreshed.refresh_token ? encryptSecret(refreshed.refresh_token) : null;
    const now = Date.now();
    const { error: updateError } = await admin.from("github_connections").update({
      access_token_ciphertext: access.ciphertext,
      access_token_iv: access.iv,
      access_token_tag: access.tag,
      refresh_token_ciphertext: refresh?.ciphertext ?? connection.refresh_token_ciphertext,
      refresh_token_iv: refresh?.iv ?? connection.refresh_token_iv,
      refresh_token_tag: refresh?.tag ?? connection.refresh_token_tag,
      access_token_expires_at: refreshed.expires_in ? new Date(now + refreshed.expires_in * 1000).toISOString() : null,
      refresh_token_expires_at: refreshed.refresh_token_expires_in
        ? new Date(now + refreshed.refresh_token_expires_in * 1000).toISOString()
        : connection.refresh_token_expires_at,
      status: "installed",
      error_message: null,
    }).eq("user_id", userId);
    if (updateError) throw new Error(`Could not persist refreshed GitHub authorization: ${updateError.message}`);
    accessToken = refreshed.access_token;
  }

  return { connection, accessToken };
}

export async function createGithubRepository(token: string, name: string, description: string) {
  return githubFetch<GithubRepo>("/user/repos", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description,
      private: true,
      auto_init: false,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    }),
  });
}

export async function ensureRepositoryInstallationAccess(token: string, installationId: number, repoId: number) {
  try {
    await githubFetch<void>(`/user/installations/${installationId}/repositories/${repoId}`, token, { method: "PUT" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("422")) return;
    throw new Error(`The GitHub App could not access the new repository. Install LYMTLESS AI BUILDER for all repositories or add this repository to the installation. ${message}`);
  }
}

export async function getRepository(token: string, fullName: string) {
  return githubFetch<GithubRepo>(`/repos/${fullName}`, token);
}

export async function pushRepositorySnapshot(options: {
  token: string;
  fullName: string;
  branch: string;
  files: SourceFile[];
  message: string;
}) {
  const encodedBranch = encodeURIComponent(options.branch);
  let headSha: string | null = null;
  let baseTreeSha: string | null = null;
  let existingPaths: string[] = [];

  try {
    const ref = await githubFetch<{ object: { sha: string } }>(`/repos/${options.fullName}/git/ref/heads/${encodedBranch}`, options.token);
    headSha = ref.object.sha;
    const commit = await githubFetch<{ tree: { sha: string } }>(`/repos/${options.fullName}/git/commits/${headSha}`, options.token);
    baseTreeSha = commit.tree.sha;
    const tree = await githubFetch<{ tree: Array<{ path: string; type: string }> }>(`/repos/${options.fullName}/git/trees/${baseTreeSha}?recursive=1`, options.token);
    existingPaths = tree.tree.filter((item) => item.type === "blob").map((item) => item.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("409") && !message.includes("404")) throw error;
  }

  const current = new Set(options.files.map((file) => safeSourcePath(file.path)));
  const treeEntries: Array<Record<string, unknown>> = options.files.map((file) => ({
    path: safeSourcePath(file.path),
    mode: "100644",
    type: "blob",
    content: file.content,
  }));
  for (const existing of existingPaths) {
    if (current.has(existing) || !isManagedRepositoryPath(existing)) continue;
    treeEntries.push({ path: existing, mode: "100644", type: "blob", sha: null });
  }

  const tree = await githubFetch<{ sha: string }>(`/repos/${options.fullName}/git/trees`, options.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(baseTreeSha ? { base_tree: baseTreeSha } : {}), tree: treeEntries }),
  });
  const commit = await githubFetch<{ sha: string }>(`/repos/${options.fullName}/git/commits`, options.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: options.message, tree: tree.sha, parents: headSha ? [headSha] : [] }),
  });

  if (headSha) {
    await githubFetch(`/repos/${options.fullName}/git/refs/heads/${encodedBranch}`, options.token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  } else {
    await githubFetch(`/repos/${options.fullName}/git/refs`, options.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${options.branch}`, sha: commit.sha }),
    });
  }
  return commit.sha;
}

export async function readRepositorySnapshot(options: { token: string; fullName: string; commitSha: string }): Promise<SourceFile[]> {
  const commit = await githubFetch<{ tree: { sha: string } }>(`/repos/${options.fullName}/git/commits/${options.commitSha}`, options.token);
  const tree = await githubFetch<{ tree: Array<{ path: string; type: string; sha: string; size?: number }> }>(
    `/repos/${options.fullName}/git/trees/${commit.tree.sha}?recursive=1`,
    options.token,
  );
  const candidates = tree.tree
    .filter((item) => item.type === "blob" && (item.size ?? 0) <= MAX_FILE_BYTES)
    .filter((item) => isManagedRepositoryPath(item.path))
    .slice(0, MAX_IMPORT_FILES);

  const files: SourceFile[] = [];
  let totalBytes = 0;
  for (let index = 0; index < candidates.length; index += 10) {
    const batch = candidates.slice(index, index + 10);
    const blobs = await Promise.all(batch.map(async (item) => {
      const blob = await githubFetch<{ content: string; encoding: string }>(`/repos/${options.fullName}/git/blobs/${item.sha}`, options.token);
      if (blob.encoding !== "base64") return null;
      const buffer = Buffer.from(blob.content.replace(/\n/g, ""), "base64");
      if (buffer.includes(0)) return null;
      return { path: safeSourcePath(item.path), content: buffer.toString("utf8"), bytes: buffer.byteLength };
    }));
    for (const blob of blobs) {
      if (!blob) continue;
      totalBytes += blob.bytes;
      if (totalBytes > MAX_IMPORT_BYTES) throw new Error("GitHub repository source exceeds the 2 MB import limit");
      files.push({ path: blob.path, content: blob.content });
    }
  }
  if (!files.some((file) => file.path === "package.json")) throw new Error("GitHub repository does not contain a supported generated app package.json");
  return files;
}

function isManagedRepositoryPath(input: string) {
  let safe: string;
  try { safe = safeSourcePath(input); } catch { return false; }
  if (safe.startsWith(".github/") || safe.startsWith("node_modules/") || safe.startsWith("dist/")) return false;
  const base = safe.split("/").at(-1) || "";
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return false;
  if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|gz|mp4|mov|mp3|wav)$/i.test(safe)) return false;
  return true;
}

export function repositoryNameFromProject(name: string, projectId: string) {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "app";
  return `${slug}-${projectId.slice(0, 6)}`;
}
