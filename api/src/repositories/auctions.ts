import type { Pool, PoolClient } from "pg";

export type AuctionStatus =
  | "scheduled"
  | "live"
  | "pending_seller"
  | "counter_offered"
  | "sold"
  | "unsold"
  | "cancelled";

export interface Auction {
  id: string;
  vehicle_id: string;
  created_by: string;
  status: AuctionStatus;
  starting_price: string;
  reserve_price: string | null;
  current_price: string;
  high_bid_id: string | null;
  gel_rate: string | null;
  buyer_fee_percent: string | null;
  final_price: string | null;
  sold_to: string | null;
  sold_at: Date | null;
  starts_at: Date;
  ends_at: Date;
  soft_close_window: string;
  seller_decision_by: Date | null;
  buy_now_price: string | null;
}

export interface NewAuctionInput {
  vehicleId: string;
  createdBy: string;
  startingPrice: string;
  reservePrice: string;
  startsAt: Date;
  endsAt: Date;
  gelRate?: string;
  buyNowPrice?: string;
}

export async function insert(pool: Pool, input: NewAuctionInput): Promise<Auction> {
  const { rows } = await pool.query<Auction>(
    `insert into auctions
       (vehicle_id, created_by, status, starting_price, reserve_price, current_price,
        starts_at, ends_at, gel_rate, buy_now_price)
     values ($1, $2, 'scheduled', $3, $4, $3, $5, $6, $7, $8)
     returning *`,
    [
      input.vehicleId,
      input.createdBy,
      input.startingPrice,
      input.reservePrice,
      input.startsAt,
      input.endsAt,
      input.gelRate ?? null,
      input.buyNowPrice ?? null,
    ],
  );
  return rows[0]!;
}

// §5.2's increment table, kept in SQL (bid_increment()) so the frontend's
// "quick bid the minimum" button and place_bid()/buy_now() itself can never
// drift out of sync with each other.
export async function nextMinimumBid(pool: Pool, auction: Auction): Promise<string> {
  if (!auction.high_bid_id) {
    return auction.starting_price;
  }
  const { rows } = await pool.query<{ minimum: string }>(
    "select (current_price + bid_increment(current_price))::text as minimum from auctions where id = $1",
    [auction.id],
  );
  return rows[0]!.minimum;
}

export async function buyNow(
  pool: Pool,
  auctionId: string,
  bidderId: string,
  ipAddress: string | null,
  userAgent: string | null,
): Promise<Auction> {
  const { rows } = await pool.query<Auction>(
    "select * from buy_now($1, $2, $3, $4) as auction",
    [auctionId, bidderId, ipAddress, userAgent],
  );
  return rows[0]!;
}

export async function findById(pool: Pool, id: string): Promise<Auction | null> {
  const { rows } = await pool.query<Auction>("select * from auctions where id = $1", [id]);
  return rows[0] ?? null;
}

export interface ListFilters {
  status?: AuctionStatus | AuctionStatus[];
  make?: string;
  year?: number;
}

export async function list(pool: Pool, filters: ListFilters = {}): Promise<Auction[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    params.push(statuses);
    clauses.push(`a.status = any($${params.length})`);
  }
  if (filters.make) {
    params.push(filters.make);
    clauses.push(`v.make = $${params.length}`);
  }
  if (filters.year) {
    params.push(filters.year);
    clauses.push(`v.year = $${params.length}`);
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const { rows } = await pool.query<Auction>(
    `select a.* from auctions a join vehicles v on v.id = a.vehicle_id ${where} order by a.starts_at desc`,
    params,
  );
  return rows;
}

// BACKEND_SPEC.md §12: max_amount is bidder-only (never shown to anyone
// else, team included); ip_address/user_agent are team-only (shown to
// team on every row, hidden from everyone else). Two independent
// column-level redactions applied per-row in SQL, not two separate views,
// so there's one query to keep correct instead of two to keep in sync.
export async function listBids(
  pool: Pool,
  auctionId: string,
  viewerId: string | null,
  isTeam: boolean,
) {
  const teamColumns = isTeam ? ", ip_address, user_agent" : "";
  const { rows } = await pool.query(
    `select id, auction_id, bidder_id, amount, is_proxy, created_at,
            case when bidder_id = $2 then max_amount else null end as max_amount
            ${teamColumns}
       from bids
      where auction_id = $1
      order by amount desc, created_at asc`,
    [auctionId, viewerId],
  );
  return rows;
}

// cancel_auction() (db/009_auction_events.sql) does the update and logs an
// auction_events row atomically, in the same statement — see that
// migration for why.
export async function cancel(pool: Pool, auctionId: string, actorId: string): Promise<Auction | null> {
  const { rows } = await pool.query<Auction>("select * from cancel_auction($1, $2) as auction", [
    auctionId,
    actorId,
  ]);
  return rows[0] ?? null;
}

// §6: seller accept/decline on a pending_seller auction. In phase 1 the
// "seller" acting here is always team, since every vehicle is company-owned.
export async function acceptAsIs(pool: Pool, auctionId: string): Promise<Auction | null> {
  const { rows } = await pool.query<Auction>(
    `update auctions
        set status = 'sold',
            final_price = current_price,
            sold_to = (select bidder_id from bids where id = high_bid_id),
            sold_at = now()
      where id = $1 and status = 'pending_seller'
      returning *`,
    [auctionId],
  );
  return rows[0] ?? null;
}

export async function decline(pool: Pool, auctionId: string): Promise<Auction | null> {
  const { rows } = await pool.query<Auction>(
    `update auctions set status = 'unsold'
      where id = $1 and status = 'pending_seller'
      returning *`,
    [auctionId],
  );
  return rows[0] ?? null;
}

// §7: post-sale settlement. Manual reassignment to the underbidder when the
// winner doesn't pay. status stays 'sold' throughout.
//
// reassign_sale() (db/009_auction_events.sql) still requires newSoldTo to
// have a real bid on this auction (see the migration for why: "no matching
// bid" yielding zero rows is what turns into a clean cannot_reassign error
// downstream, instead of a raw constraint violation), and now also logs an
// auction_events row atomically, in the same statement as the update.
export async function reassignSale(
  pool: Pool,
  auctionId: string,
  newSoldTo: string,
  actorId: string,
): Promise<Auction | null> {
  const { rows } = await pool.query<Auction>(
    "select * from reassign_sale($1, $2, $3) as auction",
    [auctionId, newSoldTo, actorId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------
// Background jobs (§8). Each uses FOR UPDATE SKIP LOCKED so a second
// instance of the job runner doesn't double-process a row.
// ---------------------------------------------------------------

export async function openScheduledAuctions(client: PoolClient): Promise<number> {
  const { rowCount } = await client.query(
    `update auctions set status = 'live'
      where id in (
        select id from auctions
         where status = 'scheduled' and starts_at <= now()
         for update skip locked
      )`,
  );
  return rowCount ?? 0;
}

export interface ClosedAuction {
  id: string;
  outcome: "unsold" | "sold" | "pending_seller";
}

export async function closeExpiredAuctions(client: PoolClient): Promise<ClosedAuction[]> {
  // reserve_met computed in SQL (numeric >= numeric), not with Number() on
  // the fetched strings — this decides whether a car legally sells, and
  // hard rule #1 says money comparisons don't go through a JS float.
  const { rows: candidates } = await client.query<Auction & { reserve_met: boolean }>(
    `select *, (reserve_price is null or current_price >= reserve_price) as reserve_met
       from auctions
      where status = 'live' and ends_at <= now()
      for update skip locked`,
  );

  const closed: ClosedAuction[] = [];

  for (const auction of candidates) {
    if (!auction.high_bid_id) {
      await client.query("update auctions set status = 'unsold' where id = $1", [auction.id]);
      closed.push({ id: auction.id, outcome: "unsold" });
      continue;
    }

    if (auction.reserve_met) {
      await client.query(
        `update auctions
            set status = 'sold',
                final_price = current_price,
                sold_to = (select bidder_id from bids where id = high_bid_id),
                sold_at = now()
          where id = $1`,
        [auction.id],
      );
      closed.push({ id: auction.id, outcome: "sold" });
    } else {
      await client.query(
        `update auctions
            set status = 'pending_seller',
                seller_decision_by = now() + interval '48 hours'
          where id = $1`,
        [auction.id],
      );
      closed.push({ id: auction.id, outcome: "pending_seller" });
    }
  }

  return closed;
}

export async function expireSellerDecisions(client: PoolClient): Promise<number> {
  const { rowCount } = await client.query(
    `update auctions set status = 'unsold'
      where id in (
        select id from auctions
         where status = 'pending_seller' and seller_decision_by <= now()
         for update skip locked
      )`,
  );
  return rowCount ?? 0;
}
