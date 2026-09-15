import type { Pool } from "pg";

export interface Bid {
  id: string;
  auction_id: string;
  bidder_id: string;
  amount: string;
  max_amount: string | null;
  is_proxy: boolean;
  created_at: Date;
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
): Promise<Bid> {
  const { rows } = await pool.query<Bid>(
    "select * from place_bid($1, $2, $3, $4, $5) as bid",
    [auctionId, bidderId, maxAmount, ipAddress, userAgent],
  );
  return rows[0]!;
}
