import { hash, verify, Algorithm } from "@node-rs/argon2";

// CLAUDE.md: "Passwords: argon2id. Not bcrypt, not sha256." — pin the
// algorithm explicitly rather than relying on the library's default.
const OPTIONS = { algorithm: Algorithm.Argon2id };

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  return verify(passwordHash, plain, OPTIONS);
}
