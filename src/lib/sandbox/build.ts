import path from "node:path";
import { Sandbox } from "@vercel/sandbox";

export const PREVIEW_PORT = 5173;
export const SANDBOX_ROOT = "/vercel/sandbox";
const MAX_LOG_CHARS = 60_000;
const PLAYWRIGHT_VERSION = "1.64.0";
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

export type BrowserQaFinding = {
  severity: "error" | "warning";
  code: string;
  message: string;
  viewport?: string;
  route?: string;
};

export type BrowserQaResult = {
  passed: boolean;
  findings: BrowserQaFinding[];
  viewports: Array<{
    name: string;
    route: string;
    width: number;
    height: number;
    textLength: number;
    interactiveCount: number;
  }>;
};

export function sandboxAuthConfigured() {
  return Boolean(
    process.env.VERCEL_OIDC_TOKEN ||
      (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID),
  );
}

export async function createBuildSandbox(env: Record<string, string> = {}) {
  const tokenAuth =
    process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
      ? {
          token: process.env.VERCEL_TOKEN,
          teamId: process.env.VERCEL_TEAM_ID,
          projectId: process.env.VERCEL_PROJECT_ID,
        }
      : {};

  return Sandbox.create({
    persistent: false,
    timeout: 30 * 60 * 1000,
    ports: [PREVIEW_PORT],
    resources: { vcpus: 2 },
    networkPolicy: "allow-all",
    env,
    ...tokenAuth,
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

export async function installBrowserQa(sandbox: Sandbox) {
  const install = await runCaptured(sandbox, "npm", [
    "install",
    "--no-save",
    "--no-audit",
    "--no-fund",
    `playwright@${PLAYWRIGHT_VERSION}`,
  ]);
  if (install.exitCode !== 0) throw new Error(`Could not install browser QA runtime: ${install.combined}`);

  const browser = await runCaptured(sandbox, "./node_modules/.bin/playwright", ["install", "--with-deps", "chromium"]);
  if (browser.exitCode !== 0) throw new Error(`Could not install Chromium for browser QA: ${browser.combined}`);

  return clipLog(`${install.combined}\n${browser.combined}`.trim());
}

export async function startPreview(sandbox: Sandbox) {
  await stopPreview(sandbox);
  const start = await runCaptured(sandbox, "bash", [
    "-lc",
    `nohup ./node_modules/.bin/vite preview --host 0.0.0.0 --port ${PREVIEW_PORT} > /tmp/lymtless-preview.log 2>&1 & echo $! > /tmp/lymtless-preview.pid`,
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

export async function stopPreview(sandbox: Sandbox) {
  await runCaptured(sandbox, "bash", [
    "-lc",
    "if [ -f /tmp/lymtless-preview.pid ]; then kill $(cat /tmp/lymtless-preview.pid) 2>/dev/null || true; rm -f /tmp/lymtless-preview.pid; fi",
  ]);
}

export async function runBrowserQa(
  sandbox: Sandbox,
  routes: string[] = ["/"],
): Promise<{ result: BrowserQaResult; log: string }> {
  const qaPath = `${SANDBOX_ROOT}/.lymtless-browser-qa.cjs`;
  const safeRoutes = normalizeQaRoutes(routes);
  await sandbox.writeFiles([{ path: qaPath, content: Buffer.from(browserQaScript(safeRoutes), "utf8") }]);
  const run = await runCaptured(sandbox, "node", [qaPath]);
  if (run.exitCode !== 0) throw new Error(`Browser QA runner failed: ${run.combined}`);

  const line = run.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("Browser QA returned no result");

  let result: BrowserQaResult;
  try {
    result = JSON.parse(line) as BrowserQaResult;
  } catch {
    throw new Error(`Browser QA returned invalid JSON: ${clipLog(run.stdout, 10_000)}`);
  }

  return { result, log: clipLog(JSON.stringify(result, null, 2), 30_000) };
}

export async function lockSandboxNetwork(sandbox: Sandbox) {
  await sandbox.update({ networkPolicy: "deny-all" });
}

function normalizeQaRoutes(routes: string[]) {
  const normalized = new Set<string>(["/"]);
  for (const candidate of routes) {
    if (typeof candidate !== "string") continue;
    const route = candidate.trim();
    if (!route.startsWith("/") || route.includes(":") || route.includes("*") || route.includes("[") || route.includes("]")) continue;
    if (!/^\/[A-Za-z0-9_/?#&=.~-]*$/.test(route)) continue;
    normalized.add(route);
    if (normalized.size >= 8) break;
  }
  return Array.from(normalized);
}

function browserQaScript(routes: string[]) {
  const serializedRoutes = JSON.stringify(routes);
  return `
const { chromium } = require('playwright');

const target = 'http://127.0.0.1:${PREVIEW_PORT}';
const routes = ${serializedRoutes};
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const findings = [];
  const results = [];

  try {
    for (const viewport of viewports) {
      for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
        const route = routes[routeIndex];
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        const page = await context.newPage();
        const consoleErrors = [];
        const pageErrors = [];
        const failedRequests = [];

        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 1000));
        });
        page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 1000)));
        page.on('requestfailed', (request) => {
          const type = request.resourceType();
          if (['document', 'script', 'stylesheet', 'fetch', 'xhr'].includes(type)) {
            failedRequests.push((request.url() + ' — ' + (request.failure()?.errorText || 'failed')).slice(0, 1200));
          }
        });

        let response;
        try {
          const url = new URL(route, target).toString();
          response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(900);
        } catch (error) {
          findings.push({ severity: 'error', code: 'navigation_failed', message: String(error).slice(0, 1200), viewport: viewport.name, route });
          await context.close();
          continue;
        }

        if (!response || response.status() >= 400) {
          findings.push({ severity: 'error', code: 'http_error', message: 'Preview returned HTTP ' + (response?.status() ?? 'no response'), viewport: viewport.name, route });
        }

        const metrics = await page.evaluate(() => {
          const body = document.body;
          const textLength = (body?.innerText || '').trim().length;
          const interactiveCount = document.querySelectorAll('button,a,input,select,textarea,[role="button"]').length;
          const brokenImages = Array.from(document.images)
            .filter((img) => img.complete && img.naturalWidth === 0)
            .map((img) => img.currentSrc || img.src)
            .slice(0, 10);
          const horizontalOverflow = document.documentElement.scrollWidth > window.innerWidth + 4;
          const bodyHeight = body?.getBoundingClientRect().height || 0;
          return { textLength, interactiveCount, brokenImages, horizontalOverflow, bodyHeight };
        });

        results.push({ name: viewport.name, route, width: viewport.width, height: viewport.height, textLength: metrics.textLength, interactiveCount: metrics.interactiveCount });

        if (metrics.textLength < 10 && metrics.interactiveCount === 0) {
          findings.push({ severity: 'error', code: 'blank_page', message: 'Page rendered without meaningful text or interactive UI.', viewport: viewport.name, route });
        }
        if (metrics.bodyHeight < 80) {
          findings.push({ severity: 'error', code: 'collapsed_layout', message: 'Rendered body height is unexpectedly small.', viewport: viewport.name, route });
        }
        if (metrics.horizontalOverflow) {
          findings.push({ severity: 'error', code: 'horizontal_overflow', message: 'Layout overflows the viewport horizontally.', viewport: viewport.name, route });
        }
        for (const src of metrics.brokenImages) {
          findings.push({ severity: 'error', code: 'broken_image', message: 'Image failed to render: ' + src.slice(0, 800), viewport: viewport.name, route });
        }
        for (const message of pageErrors.slice(0, 10)) {
          findings.push({ severity: 'error', code: 'page_error', message, viewport: viewport.name, route });
        }
        for (const message of consoleErrors.slice(0, 10)) {
          findings.push({ severity: 'error', code: 'console_error', message, viewport: viewport.name, route });
        }
        for (const message of failedRequests.slice(0, 10)) {
          findings.push({ severity: 'warning', code: 'request_failed', message, viewport: viewport.name, route });
        }

        if (routeIndex === 0) {
          await page.screenshot({ path: '/tmp/lymtless-' + viewport.name + '.png', fullPage: true });
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const deduped = Array.from(new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values());
  const result = { passed: !deduped.some((finding) => finding.severity === 'error'), findings: deduped, viewports: results };
  console.log(JSON.stringify(result));
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

export function clipLog(value: string, max = MAX_LOG_CHARS) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.floor(max * 0.4))}\n…[log truncated]…\n${value.slice(-Math.floor(max * 0.6))}`;
}
