import OpenAI from "openai";

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_GATEWAY_MODEL = "openai/gpt-6-astra";
const DEFAULT_DIRECT_MODEL = "gpt-6-astra";

function directOpenAIConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function requestTimeoutMs() {
  const parsed = Number(process.env.OPENAI_DIRECT_TIMEOUT_MS || "120000");
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : 120_000;
}

function normalizeModel(raw: string | undefined, fallback: string) {
  const candidate = (raw || fallback).trim();
  if (directOpenAIConfigured()) {
    return candidate.startsWith("openai/") ? candidate.slice("openai/".length) : candidate;
  }
  return candidate.includes("/") ? candidate : `openai/${candidate}`;
}

export function createAIClient(requestOidcToken?: string | null) {
  const directKey = process.env.OPENAI_API_KEY?.trim();
  if (directKey) {
    return new OpenAI({
      apiKey: directKey,
      timeout: requestTimeoutMs(),
      maxRetries: 2,
    });
  }

  const gatewayKey = requestOidcToken || process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY;
  if (!gatewayKey) {
    throw new Error(
      "AI provider authentication is unavailable. Set OPENAI_API_KEY for direct OpenAI access, or configure Vercel AI Gateway OIDC / AI_GATEWAY_API_KEY.",
    );
  }

  return new OpenAI({
    apiKey: gatewayKey,
    baseURL: GATEWAY_BASE_URL,
    timeout: requestTimeoutMs(),
    maxRetries: 2,
  });
}

export function getPlanningModel() {
  return normalizeModel(
    process.env.OPENAI_MODEL,
    directOpenAIConfigured() ? DEFAULT_DIRECT_MODEL : DEFAULT_GATEWAY_MODEL,
  );
}

export function getCodeModel() {
  return normalizeModel(
    process.env.OPENAI_CODE_MODEL || process.env.OPENAI_MODEL,
    directOpenAIConfigured() ? DEFAULT_DIRECT_MODEL : DEFAULT_GATEWAY_MODEL,
  );
}
