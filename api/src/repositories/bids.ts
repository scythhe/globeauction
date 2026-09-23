import type { Pool } from "pg";

export interface Bid {
  id: string;
  auction_id: string;
  bidder_id: string;
  amount: string;
  max_amount: string | null;
  is_proxy: boolean;
  created_at: Date;
  // place_bid() returns the full bids%rowtype, so these are always present
  // on the raw row — team-only per BACKEND_SPEC.md §12, callers must strip
  // them before the response reaches a non-team actor.
  ip_address: string | null;
  user_agent: string | null;
  // Internal bookkeeping for void_last_bid() (db/010) — not spec-covered
  // sensitive data, but not meaningful to a bidder either; stripped the
  // same way as ip_address/user_agent for the same reason: an interface
  // that quietly omitted real columns is exactly how that leak happened
  // before.
  batch_id: string | null;
  voided_at: Date | null;
  voided_by: string | null;
}

// The only function that writes to `bids`, per CLAUDE.md's bidding
// exception — everything runs inside db/002_bid_function.sql's
// place_bid(), one transaction, FOR UPDATE on the auction row.
export async function placeBid(
  pool: Pool,
  auctionId: string,
  bidderId: string,
  maxAmount: string,
  ipAddress: string | null = null,
  userAgent: string | null = null,
  // db/014_flat_bid.sql: Monster Bid / pre-bidding pass true so the amount
  // they typed becomes the visible price outright instead of being
  // proxy-compressed the way Quick Bid's is. Defaults false so every
  // existing Quick Bid call keeps proxy behavior unchanged.
  flat: boolean = false,
): Promise<Bid> {
  const { rows } = await pool.query<Bid>(
    "select * from place_bid($1, $2, $3, $4, $5, $6) as bid",
    [auctionId, bidderId, maxAmount, ipAddress, userAgent, flat],
  );
  return rows[0]!;
}
