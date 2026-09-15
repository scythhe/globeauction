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

// place_bid() (db/002_bid_function.sql) raises these as plain exceptions;
// this is the single place that translates them into BACKEND_SPEC.md §12's
// structured error shape, e.g. { error: "bid_too_low", minimum, current_price }.
export async function placeBid(
  pool: Pool,
  actor: Actor | null,
  auctionId: string,
  maxAmount: number,
  requestMeta: { ipAddress?: string | null; userAgent?: string | null } = {},
) {
  if (!actor) throw Errors.unauthenticated();

  // Postgres numeric accepts 'NaN'/'Infinity' as real values, and orders
  // NaN as GREATER than every finite number — the opposite of IEEE float
  // semantics. Without this check, max_amount: "NaN" makes a bidder
  // permanently unbeatable: every p_max_amount > v_high.max_amount
  // comparison in place_bid() loses to NaN. Confirmed exploitable before
  // this check existed.
  if (!Number.isFinite(maxAmount) || maxAmount <= 0) {
    throw Errors.validation("max_amount must be a finite positive number");
  }

  try {
    return await bidsRepo.placeBid(
      pool,
      auctionId,
      actor.id,
      maxAmount.toFixed(2),
      requestMeta.ipAddress ?? null,
      requestMeta.userAgent ?? null,
    );
  } catch (err) {
    if (isPgErrorLike(err) && KNOWN_BID_ERRORS.has(err.message)) {
      const extra = err.detail ? JSON.parse(err.detail) : {};
      throw new ApiError(400, err.message, extra);
    }
    throw err;
  }
}
