import { randomBytes, createHash } from "node:crypto";

// The bearer token handed to the client. Never stored — only its hash is.
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_LIFETIME_MS);
}
