import OpenAI from "openai";

const OPENAI_DIRECT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 120_000;

type ErrorLike = {
  status?: unknown;
  code?: unknown;
  type?: unknown;
  message?: unknown;
};

export function isDirectOpenAIConfigured() {
  return Boolean(process.env.OPENAI_DIRECT_API_KEY?.trim());
}

export function normalizeOpenAIModel(value: string | undefined, fallback: string) {
  const model = value?.trim() || fallback;
  return model.replace(/^openai\//i, "");
}

export function resolveOpenAIModels(options: {
  primary: string | undefined;
  fallback: string | undefined;
  defaultPrimary: string;
  defaultFallback?: string;
}) {
  const primary = normalizeOpenAIModel(options.primary, options.defaultPrimary);
  const fallback = normalizeOpenAIModel(
    options.fallback,
    options.defaultFallback || options.defaultPrimary,
  );

  return {
    primary,
    fallback: fallback === primary ? null : fallback,
  };
}

export async function runDirectOpenAIWithFallback<T>(options: {
  operation: string;
  primaryModel: string;
  fallbackModel?: string | null;
  execute: (client: OpenAI, model: string) => Promise<T>;
}): Promise<{ value: T; model: string; usedFallback: boolean }> {
  const client = createDirectOpenAIClient();
  const models = Array.from(
    new Set(
      [options.primaryModel, options.fallbackModel]
        .filter((model): model is string => Boolean(model?.trim()))
        .map((model) => normalizeOpenAIModel(model, options.primaryModel)),
    ),
  );

  let lastError: unknown;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];

    try {
      const value = await options.execute(client, model);
      return { value, model, usedFallback: index > 0 };
    } catch (error) {
      lastError = error;
      const nextModel = models[index + 1];

      if (!nextModel || !shouldTryFallbackModel(error)) throw error;

      console.warn(
        `[OpenAI direct] ${options.operation} failed on ${model}; retrying with ${nextModel}.`,
        safeErrorSummary(error),
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`OpenAI ${options.operation} failed`);
}

function createDirectOpenAIClient() {
  const apiKey = process.env.OPENAI_DIRECT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENAI_DIRECT_API_KEY is not configured. Add a direct OpenAI API key to the server environment.",
    );
  }

  const configuredTimeout = Number(process.env.OPENAI_DIRECT_TIMEOUT_MS);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout >= 10_000
    ? Math.floor(configuredTimeout)
    : DEFAULT_TIMEOUT_MS;

  return new OpenAI({
    apiKey,
    baseURL: OPENAI_DIRECT_BASE_URL,
    maxRetries: 2,
    timeout,
  });
}

function shouldTryFallbackModel(error: unknown) {
  const details = asErrorLike(error);
  const status = typeof details.status === "number" ? details.status : null;
  const code = typeof details.code === "string" ? details.code.toLowerCase() : "";
  const type = typeof details.type === "string" ? details.type.toLowerCase() : "";
  const message = typeof details.message === "string" ? details.message.toLowerCase() : "";
  const combined = `${code} ${type} ${message}`;

  // Switching models cannot repair authentication, billing, or exhausted account quota.
  if (
    status === 401 ||
    combined.includes("invalid_api_key") ||
    combined.includes("authentication") ||
    combined.includes("insufficient_quota") ||
    combined.includes("billing") ||
    combined.includes("credit card")
  ) {
    return false;
  }

  if (status === 404 || status === 408 || status === 409 || status === 429) return true;
  if (status !== null && status >= 500) return true;

  return (
    combined.includes("model_not_found") ||
    combined.includes("rate_limit") ||
    combined.includes("server_error") ||
    combined.includes("temporarily unavailable") ||
    combined.includes("timeout")
  );
}

function asErrorLike(error: unknown): ErrorLike {
  if (error && typeof error === "object") return error as ErrorLike;
  return { message: String(error) };
}

function safeErrorSummary(error: unknown) {
  const details = asErrorLike(error);
  return {
    status: typeof details.status === "number" ? details.status : undefined,
    code: typeof details.code === "string" ? details.code : undefined,
    type: typeof details.type === "string" ? details.type : undefined,
    message: typeof details.message === "string" ? details.message.slice(0, 500) : undefined,
  };
}
