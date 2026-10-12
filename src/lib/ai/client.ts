import OpenAI from "openai";

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export function createAIClient(requestOidcToken?: string | null) {
  const apiKey = requestOidcToken || process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Vercel AI Gateway authentication is unavailable. Enable Vercel OIDC for this project or set AI_GATEWAY_API_KEY for local development.",
    );
  }

  return new OpenAI({
    apiKey,
    baseURL: GATEWAY_BASE_URL,
  });
}

export function getPlanningModel() {
  return process.env.OPENAI_MODEL || "openai/gpt-6-astra";
}

export function getCodeModel() {
  return process.env.OPENAI_CODE_MODEL || process.env.OPENAI_MODEL || "openai/gpt-6-astra";
}
