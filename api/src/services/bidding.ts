import type { Pool } from "pg";
import * as bidsRepo from "../repositories/bids.ts";
import { ApiError, Errors } from "../errors.ts";
import type { Actor } from "../types.ts";

const KNOWN_BID_ERRORS = new Set([
  "auction_not_live",
  "account_inactive",
  "bidding_disabled",
  "own_organization",
  "bid_too_low",
]);

interface PgErrorLike {
  message: string;
  detail?: string;
}

function isPgErrorLike(err: unknown): err is PgErrorLike {
  return typeof err === "object" && err !== null && "message" in err;
}

// At most 15 integer digits and 2 decimal places — a plain decimal money
// string, nothing else (no exponents, no leading '+', no thousands separators).
const MAX_AMOUNT_PATTERN = /^\d{1,15}(\.\d{1,2})?$/;

// CLAUDE.md hard rule #1: money is numeric, never a JS float. A request
// body's max_amount arrives as a string; parsing it with Number() and
// writing it back out with .toFixed(2) round-trips it through IEEE 754
// binary floating point, which cannot represent every two-decimal value
// exactly (e.g. some values .toFixed(2) rounds differently than the
// original decimal intended). Validating the string's shape directly and
// passing it straight to Postgres `numeric` avoids that round-trip
// entirely. A plain `number` is still accepted for trusted in-process
// callers (tests, internal services) that already hold a parsed amount.
function normalizeMaxAmount(input: unknown): string {
  if (typeof input === "number") {
    // Same NaN/Infinity concern as below: Postgres numeric accepts
    // 'NaN'/'Infinity' and orders NaN as GREATER than every finite value
    // (opposite of IEEE float) — max_amount: NaN made a bidder
    // permanently unbeatable before this check existed. Confirmed exploitable.
    if (!Number.isFinite(input) || input <= 0) {
      throw Errors.validation("max_amount must be a finite positive number");
    }
    return input.toFixed(2);
  }

  if (typeof input !== "string") {
    throw Errors.validation("max_amount must be a finite positive number");
  }

  const trimmed = input.trim();
  if (!MAX_AMOUNT_PATTERN.test(trimmed) || Number(trimmed) <= 0) {
    throw Errors.validation("max_amount must be a finite positive number");
  }
  return trimmed;
}

// place_bid() (db/002_bid_function.sql) raises these as plain exceptions;
// this is the single place that translates them into BACKEND_SPEC.md §12's
// structured error shape, e.g. { error: "bid_too_low", minimum, current_price }.
export async function placeBid(
  pool: Pool,
  actor: Actor | null,
  auctionId: string,
  maxAmount: unknown,
  requestMeta: { ipAddress?: string | null; userAgent?: string | null } = {},
) {
  if (!actor) throw Errors.unauthenticated();

  const normalizedMaxAmount = normalizeMaxAmount(maxAmount);

  try {
    const bid = await bidsRepo.placeBid(
      pool,
      auctionId,
      actor.id,
      normalizedMaxAmount,
      requestMeta.ipAddress ?? null,
      requestMeta.userAgent ?? null,
    );
    // place_bid() returns the full bids%rowtype. ip_address/user_agent are
    // team-only (BACKEND_SPEC.md §12) even on the bidder's own just-placed
    // bid — don't let them round-trip back in the API response.
    if (actor.role !== "team") {
      const { ip_address: _ip, user_agent: _ua, ...sanitized } = bid;
      return sanitized;
    }
    return bid;
  } catch (err) {
    if (isPgErrorLike(err) && KNOWN_BID_ERRORS.has(err.message)) {
      const extra = err.detail ? JSON.parse(err.detail) : {};
      throw new ApiError(400, err.message, extra);
    }
    throw err;
  }
}
