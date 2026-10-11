import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { SourceFile } from "@/lib/sandbox/build";
import { repairPatchSchema } from "@/lib/ai/schemas";
import { QA_REPAIR_SYSTEM_PROMPT, REPAIR_SYSTEM_PROMPT } from "@/lib/ai/system-prompt";

const MAX_CONTEXT_CHARS = 140_000;
const ALWAYS_INCLUDE = [
  "package.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vite.config.js",
  "src/main.tsx",
  "src/main.ts",
  "src/App.tsx",
  "src/App.ts",
];

type RepairOptions = {
  files: SourceFile[];
  failureLog: string;
  blueprint: unknown;
  systemPrompt: string;
  failureLabel: string;
  schemaName: string;
};

export async function repairBuildFailure(options: {
  files: SourceFile[];
  buildLog: string;
  blueprint: unknown;
}) {
  return runRepair({
    files: options.files,
    failureLog: options.buildLog,
    blueprint: options.blueprint,
    systemPrompt: REPAIR_SYSTEM_PROMPT,
    failureLabel: "BUILD FAILURE",
    schemaName: "build_repair_patch",
  });
}

export async function repairBrowserQaFailure(options: {
  files: SourceFile[];
  qaLog: string;
  blueprint: unknown;
}) {
  return runRepair({
    files: options.files,
    failureLog: options.qaLog,
    blueprint: options.blueprint,
    systemPrompt: QA_REPAIR_SYSTEM_PROMPT,
    failureLabel: "BROWSER QA FINDINGS",
    schemaName: "browser_qa_repair_patch",
  });
}

async function runRepair(options: RepairOptions) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured for repair");

  const model = process.env.OPENAI_REPAIR_MODEL || process.env.OPENAI_CODE_MODEL || process.env.OPENAI_MODEL || "gpt-6.1-sol";
  const client = new OpenAI({ apiKey });
  const context = selectRepairContext(options.files, options.failureLog);

  const response = await client.responses.parse({
    model,
    input: [
      { role: "system", content: options.systemPrompt },
      {
        role: "user",
        content: [
          "APPLICATION BLUEPRINT:",
          JSON.stringify(options.blueprint, null, 2),
          `\n${options.failureLabel}:`,
          options.failureLog.slice(-30_000),
          "\nRELEVANT PROJECT FILES:",
          context,
        ].join("\n"),
      },
    ],
    text: { format: zodTextFormat(repairPatchSchema, options.schemaName) },
  });

  if (!response.output_parsed) throw new Error("Repair model returned no valid patch");

  return {
    patch: response.output_parsed,
    model,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
}

function selectRepairContext(files: SourceFile[], failureLog: string) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const selected = new Set<string>();

  ALWAYS_INCLUDE.forEach((filePath) => {
    if (byPath.has(filePath)) selected.add(filePath);
  });

  const matches = failureLog.match(/[A-Za-z0-9_./@-]+\.(?:tsx?|jsx?|css|json)/g) ?? [];
  for (const match of matches) {
    const normalized = match.replace(/^\.\//, "").replace(/^\/vercel\/sandbox\//, "");
    if (byPath.has(normalized)) selected.add(normalized);
  }

  for (const file of files) {
    if (selected.size >= 30) break;
    if (file.path.startsWith("src/") && /\.(tsx?|jsx?|css)$/.test(file.path)) selected.add(file.path);
  }

  let size = 0;
  const chunks: string[] = [];
  for (const filePath of selected) {
    const file = byPath.get(filePath);
    if (!file) continue;
    const chunk = `\n--- ${file.path} ---\n${file.content}\n`;
    if (size + chunk.length > MAX_CONTEXT_CHARS) continue;
    chunks.push(chunk);
    size += chunk.length;
  }

  return chunks.join("");
}
