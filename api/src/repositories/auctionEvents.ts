import type { Pool } from "pg";

export type AuctionEventType = "cancelled" | "reassigned";

export interface AuctionEvent {
  id: string;
  auction_id: string;
  event_type: AuctionEventType;
  actor_id: string;
  occurred_at: Date;
  detail: Record<string, unknown>;
}

// Rows are only ever written by cancel_auction()/reassign_sale()
// (db/009_auction_events.sql), atomically with the state change they
// record — nothing in the TS layer inserts into this table directly.
export async function listByAuction(pool: Pool, auctionId: string): Promise<AuctionEvent[]> {
  const { rows } = await pool.query<AuctionEvent>(
    "select * from auction_events where auction_id = $1 order by occurred_at asc",
    [auctionId],
  );
  return rows;
}
