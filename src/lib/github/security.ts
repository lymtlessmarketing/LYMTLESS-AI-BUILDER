import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  tag: string;
};

type GithubState = {
  userId: string;
  projectId: string;
  expiresAt: number;
  nonce: string;
};

function encryptionKey() {
  const encoded = process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32) throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64");
  return key;
}

export function encryptSecret(value: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(secret: EncryptedSecret) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function stateSecret() {
  const secret = process.env.GITHUB_OAUTH_STATE_SECRET;
  if (!secret || secret.length < 32) throw new Error("GITHUB_OAUTH_STATE_SECRET must be at least 32 characters");
  return secret;
}

export function createGithubState(userId: string, projectId: string) {
  const payload: GithubState = {
    userId,
    projectId,
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomBytes(16).toString("hex"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", stateSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyGithubState(value: string): GithubState {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) throw new Error("Invalid GitHub OAuth state");
  const expected = createHmac("sha256", stateSecret()).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new Error("Invalid GitHub OAuth state");
  }
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid GitHub OAuth state signature");
  }
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as GithubState;
  if (!parsed.userId || !parsed.projectId || !parsed.expiresAt || parsed.expiresAt < Date.now()) {
    throw new Error("GitHub OAuth state expired or malformed");
  }
  return parsed;
}

export function verifyWebhookSignature(payload: string, signature: string | null) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not configured");
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
