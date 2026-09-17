import type { Pool } from "pg";
import * as usersRepo from "../repositories/users.ts";
import * as sessionsRepo from "../repositories/sessions.ts";
import { hashPassword, verifyPassword } from "../auth/passwords.ts";
import { generateToken, hashToken, sessionExpiry } from "../auth/tokens.ts";
import { ApiError, Errors } from "../errors.ts";
import type { Actor } from "../types.ts";

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
}

// Public self-registration only ever creates a 'buyer'. 'team' and 'dealer'
// accounts are provisioned out of band (phase 1 has no dealer flow at all,
// and letting anyone self-register as 'team' would be a privilege
// escalation bug, not a feature).
export async function register(pool: Pool, input: RegisterInput) {
  // RegisterInput types these as `string`, but that's compile-time only —
  // input is `req.body` off the wire. A non-string password (e.g. a JSON
  // number) has `.length === undefined`, and `undefined < 8` is `false`,
  // so the length check silently passed and the bad value flowed into
  // hashPassword(), crashing as an uncaught 500 instead of a clean 400.
  if (typeof input.password !== "string" || input.password.length < 8) {
    throw Errors.validation("password must be at least 8 characters");
  }
  if (typeof input.email !== "string" || input.email.length === 0) {
    throw Errors.validation("email is required");
  }
  if (typeof input.fullName !== "string" || input.fullName.length === 0) {
    throw Errors.validation("fullName is required");
  }

  const existing = await usersRepo.findByEmail(pool, input.email);
  if (existing) {
    throw new ApiError(409, "email_taken");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await usersRepo.insertBuyer(pool, {
    email: input.email,
    passwordHash,
    fullName: input.fullName,
    phone: input.phone ?? null,
  });

  return toPublicUser(user);
}

// A fixed argon2id hash to verify against when the email doesn't match any
// account, so a nonexistent-email request takes the same argon2 verify time
// as a real-email-wrong-password one. Without this, a nonexistent email
// returned in ~0-0.01s locally vs ~0.02-0.03s for a real one — small, but a
// real, measurable timing side channel for user enumeration. Computed once
// and memoized rather than on every request, since hashPassword() itself
// isn't free.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = hashPassword("equalize-timing-not-a-real-account-password");
  }
  return dummyHash;
}

export async function login(pool: Pool, email: string, password: string) {
  // Same type-confusion concern as register(): email/password are
  // `req.body` off the wire, typed as `string` only at compile time. A
  // non-string here (e.g. `{ password: 12345678 }`) must fail the same
  // way a wrong password does, not surface a distinguishable error.
  if (typeof email !== "string" || typeof password !== "string") {
    throw new ApiError(401, "invalid_credentials");
  }

  const user = await usersRepo.findByEmail(pool, email);
  const hashToVerify = user?.password_hash ?? (await getDummyHash());
  const valid = await verifyPassword(hashToVerify, password);

  if (!user || !user.is_active || !valid) {
    throw new ApiError(401, "invalid_credentials");
  }

  const token = generateToken();
  await sessionsRepo.create(pool, user.id, hashToken(token), sessionExpiry());

  return { token, user: toPublicUser(user) };
}

export async function resolveActor(pool: Pool, bearerToken: string | null): Promise<Actor | null> {
  if (!bearerToken) return null;

  const session = await sessionsRepo.findValidByTokenHash(pool, hashToken(bearerToken));
  if (!session) return null;

  const user = await usersRepo.findById(pool, session.user_id);
  if (!user || !user.is_active) return null;

  return {
    id: user.id,
    role: user.role,
    organizationId: user.organization_id,
    canBid: user.can_bid,
    isActive: user.is_active,
  };
}

// Idempotent by design — an already-revoked or unrecognized token still
// just returns; logging out is not a place to leak whether a token was
// ever valid.
export async function logout(pool: Pool, bearerToken: string | null): Promise<void> {
  if (!bearerToken) return;
  await sessionsRepo.revoke(pool, hashToken(bearerToken));
}

export async function me(pool: Pool, actor: Actor | null) {
  if (!actor) throw Errors.unauthenticated();
  const user = await usersRepo.findById(pool, actor.id);
  if (!user) throw Errors.unauthenticated();
  return toPublicUser(user);
}

function toPublicUser(user: usersRepo.User) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    fullName: user.full_name,
    canBid: user.can_bid,
  };
}
