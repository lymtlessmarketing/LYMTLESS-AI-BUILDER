import path from "node:path";
import { Sandbox } from "@vercel/sandbox";

export const PREVIEW_PORT = 5173;
export const SANDBOX_ROOT = "/vercel/sandbox";
const MAX_LOG_CHARS = 60_000;
const forbiddenCredentialPath = /(^|\/)(credentials\.json|service-account.*\.json|\.npmrc|\.yarnrc(?:\..*)?)$/i;

export type SourceFile = {
  path: string;
  content: string;
  content_hash?: string | null;
};

export type CommandCapture = {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
};

export function sandboxAuthConfigured() {
  return Boolean(
    process.env.VERCEL_OIDC_TOKEN ||
      (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID),
  );
}

export async function createBuildSandbox() {
  return Sandbox.create({
    runtime: "node24",
    persistent: false,
    timeout: 30 * 60 * 1000,
    ports: [PREVIEW_PORT],
    resources: { vcpus: 2 },
    networkPolicy: "allow-all",
  });
}

export function safeSourcePath(input: string) {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  const basename = path.posix.basename(normalized);
  const forbiddenEnv = basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example");

  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".github" ||
    normalized.startsWith(".github/") ||
    forbiddenEnv ||
    forbiddenCredentialPath.test(normalized)
  ) {
    throw new Error(`Unsafe source path: ${input}`);
  }
  return normalized;
}

export async function writeSourceFiles(sandbox: Sandbox, files: SourceFile[]) {
  const safeFiles = files.map((file) => ({ ...file, path: safeSourcePath(file.path) }));
  const directories = Array.from(
    new Set(
      safeFiles
        .map((file) => path.posix.dirname(`${SANDBOX_ROOT}/${file.path}`))
        .filter((dir) => dir !== SANDBOX_ROOT),
    ),
  );

  if (directories.length) {
    const mkdir = await sandbox.runCommand({ cmd: "mkdir", args: ["-p", ...directories] });
    if (mkdir.exitCode !== 0) throw new Error(`Could not create sandbox directories: ${clipLog(await mkdir.stderr())}`);
  }

  await sandbox.writeFiles(
    safeFiles.map((file) => ({
      path: `${SANDBOX_ROOT}/${file.path}`,
      content: Buffer.from(file.content, "utf8"),
    })),
  );
}

export async function runCaptured(
  sandbox: Sandbox,
  cmd: string,
  args: string[],
): Promise<CommandCapture> {
  const result = await sandbox.runCommand({ cmd, args });
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  const cleanOut = clipLog(stdout);
  const cleanErr = clipLog(stderr);
  return {
    exitCode: result.exitCode,
    stdout: cleanOut,
    stderr: cleanErr,
    combined: clipLog([cleanOut, cleanErr].filter(Boolean).join("\n")),
  };
}

export async function installDependencies(sandbox: Sandbox) {
  return runCaptured(sandbox, "npm", ["install", "--no-audit", "--no-fund"]);
}

export async function buildApplication(sandbox: Sandbox) {
  return runCaptured(sandbox, "npm", ["run", "build"]);
}

export async function startPreview(sandbox: Sandbox) {
  await sandbox.updateNetworkPolicy("deny-all");

  const start = await runCaptured(sandbox, "bash", [
    "-lc",
    `nohup ./node_modules/.bin/vite preview --host 0.0.0.0 --port ${PREVIEW_PORT} > /tmp/lymtless-preview.log 2>&1 & echo $!`,
  ]);
  if (start.exitCode !== 0) throw new Error(`Preview server failed to start: ${start.combined}`);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const health = await runCaptured(sandbox, "curl", [
      "-fsS",
      "--max-time",
      "2",
      `http://127.0.0.1:${PREVIEW_PORT}`,
    ]);
    if (health.exitCode === 0) {
      const log = await runCaptured(sandbox, "bash", ["-lc", "cat /tmp/lymtless-preview.log 2>/dev/null || true"]);
      return { previewUrl: sandbox.domain(PREVIEW_PORT), previewLog: log.combined };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const log = await runCaptured(sandbox, "bash", ["-lc", "cat /tmp/lymtless-preview.log 2>/dev/null || true"]);
  throw new Error(`Preview server did not become healthy. ${log.combined}`);
}

export function clipLog(value: string, max = MAX_LOG_CHARS) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.floor(max * 0.4))}\n…[log truncated]…\n${value.slice(-Math.floor(max * 0.6))}`;
}
