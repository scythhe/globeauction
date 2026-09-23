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
  "bid_limit_exceeded",
]);

interface PgErrorLike {
  message: string;
  detail?: string;
}

function isPgErrorLike(err: unknown): err is PgErrorLike {
  return typeof err === "object" && err !== null && "message" in err;
}

// At most 10 integer digits and 2 decimal places — a plain decimal money
// string, nothing else (no exponents, no leading '+', no thousands
// separators). 10 integer digits, not some rounder-looking number, because
// it has to match bids.max_amount's actual column type, numeric(12,2):
// precision 12 total digits, scale 2 for the decimals, leaving 10 for the
// integer part. This was 15 before — wider than the column ever accepted —
// so a max_amount with 11-15 integer digits passed this check and still
// blew up as an unhandled Postgres "numeric field overflow" instead of a
// clean 400. Found via a test written for the *other* digit-cap gap
// (the number-input branch below), which hit this same ceiling first.
const MAX_AMOUNT_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

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
    const formatted = input.toFixed(2);
    // The string branch below caps digits at 15 via MAX_AMOUNT_PATTERN;
    // this branch was missing the same cap, so an oversized JS number
    // (e.g. 1e26) sailed through Number.isFinite and reached place_bid()
    // as a value wider than current_price's numeric(12,2) column, which
    // would raise an unhandled Postgres overflow instead of a clean 400.
    // Re-checking the formatted output against the same pattern keeps
    // both branches enforcing one rule.
    if (!MAX_AMOUNT_PATTERN.test(formatted)) {
      throw Errors.validation("max_amount must be a finite positive number");
    }
    return formatted;
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
//
// Deliberately NOT re-checking "nobody bids on their own org's car"
// (CLAUDE.md hard rule #5) here in TypeScript — it's enforced exactly once,
// inside place_bid() itself (organization_id, not owner_id, per the rule).
// Reviewed 2026-09-22 during a security pass: this is safe today because
// place_bid() is the *only* path that ever inserts a bids row — CLAUDE.md's
// own architecture note says so, and no repository function does a raw
// insert into bids anywhere else. Adding a mirror check here would just be
// the same rule living in two places with no test forcing them to agree.
// If a second write path to bids ever gets built (bulk import, an
// admin "place bid on behalf of" tool, anything), it must either call
// place_bid() too, or this decision needs to be revisited and the check
// duplicated on purpose — not by accident.
export async function placeBid(
  pool: Pool,
  actor: Actor | null,
  auctionId: string,
  maxAmount: unknown,
  requestMeta: { ipAddress?: string | null; userAgent?: string | null } = {},
  // Monster Bid / pre-bidding only (db/014_flat_bid.sql) — see bids repo.
  flat: boolean = false,
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
      flat,
    );
    // place_bid() returns the full bids%rowtype. ip_address/user_agent are
    // team-only (BACKEND_SPEC.md §12) even on the bidder's own just-placed
    // bid — don't let them round-trip back in the API response.
    // batch_id/voided_at/voided_by are void_last_bid() bookkeeping (db/010)
    // with no meaning to anyone via this response — team's own view of
    // that is GET /:id/events, not the bid itself — so they're stripped
    // for everyone, not just non-team.
    const { batch_id: _batchId, voided_at: _voidedAt, voided_by: _voidedBy, ...rest } = bid;
    if (actor.role !== "team") {
      const { ip_address: _ip, user_agent: _ua, ...sanitized } = rest;
      return sanitized;
    }
    return rest;
  } catch (err) {
    if (isPgErrorLike(err) && KNOWN_BID_ERRORS.has(err.message)) {
      const extra = err.detail ? JSON.parse(err.detail) : {};
      throw new ApiError(400, err.message, extra);
    }
    throw err;
  }
}
