import { zodTextFormat } from "openai/helpers/zod";
import type { Sandbox } from "@vercel/sandbox";
import {
  resolveOpenAIModels,
  runDirectOpenAIWithFallback,
} from "@/lib/ai/openai-direct";
import { visualReviewSchema, type VisualReview } from "@/lib/ai/schemas";

const MAX_IMAGE_BYTES = 19_000_000;
const SCREENSHOTS = [
  { viewport: "desktop", path: "/tmp/lymtless-desktop.png" },
  { viewport: "tablet", path: "/tmp/lymtless-tablet.png" },
  { viewport: "mobile", path: "/tmp/lymtless-mobile.png" },
] as const;

const VISUAL_REVIEW_PROMPT = `You are the visual QA reviewer for LYMTLESS AI BUILDER.
Review the supplied screenshots of the same generated web application at desktop, tablet, and mobile sizes.
Judge production readiness, not personal taste.

Fail only for clear user-facing visual defects such as:
- clipped, overlapping, cut-off, or inaccessible content
- severe spacing/alignment failures
- unreadable text or clearly insufficient contrast
- broken responsive composition
- controls that are visibly unusable or off-screen
- huge unintended blank regions or collapsed sections
- visibly broken imagery
- obvious unstyled/default output that contradicts the supplied design direction
- materially inconsistent hierarchy or component treatment that makes the UI look unfinished

Use warnings for subjective polish opportunities that should not block a build.
Do not invent defects that are not visible. Do not penalize a valid minimalist design merely for being simple.
Set passed=false when any error-level finding exists. Give a 0-100 production-readiness score for informational use.`;

export async function reviewVisuals(options: {
  sandbox: Sandbox;
  blueprint: unknown;
}): Promise<{ review: VisualReview; model: string; usedFallback: boolean; inputTokens: number | null; outputTokens: number | null }> {
  const models = resolveOpenAIModels({
    primary: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL,
    fallback: process.env.OPENAI_VISION_FALLBACK_MODEL || process.env.OPENAI_FALLBACK_MODEL,
    defaultPrimary: "gpt-6.1-sol",
    defaultFallback: "gpt-6-luna",
  });
  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "high" }
  > = [
    {
      type: "input_text",
      text: `APPLICATION BLUEPRINT:\n${JSON.stringify(options.blueprint, null, 2)}\n\nReview all screenshots together for cross-viewport consistency and production readiness.`,
    },
  ];

  for (const screenshot of SCREENSHOTS) {
    const buffer = await options.sandbox.readFileToBuffer({ path: screenshot.path });
    if (!buffer) throw new Error(`Visual QA screenshot is missing: ${screenshot.viewport}`);
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error(`Visual QA screenshot is too large: ${screenshot.viewport}`);
    content.push({ type: "input_text", text: `${screenshot.viewport.toUpperCase()} SCREENSHOT` });
    content.push({ type: "input_image", image_url: `data:image/png;base64,${buffer.toString("base64")}`, detail: "high" });
  }

  const ai = await runDirectOpenAIWithFallback({
    operation: "visual QA review",
    primaryModel: models.primary,
    fallbackModel: models.fallback,
    execute: (client, model) => client.responses.parse({
      model,
      input: [
        { role: "system", content: VISUAL_REVIEW_PROMPT },
        { role: "user", content },
      ],
      text: { format: zodTextFormat(visualReviewSchema, "visual_qa_review") },
    }),
  });

  const response = ai.value;
  if (!response.output_parsed) throw new Error("Visual review model returned no valid structured result");
  const parsed = response.output_parsed;
  const hasBlockingFinding = parsed.findings.some((finding) => finding.severity === "error");
  const review: VisualReview = {
    ...parsed,
    passed: !hasBlockingFinding,
  };

  return {
    review,
    model: ai.model,
    usedFallback: ai.usedFallback,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
}
