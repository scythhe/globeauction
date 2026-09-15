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
}

export interface NewAuctionInput {
  vehicleId: string;
  createdBy: string;
  startingPrice: string;
  reservePrice: string;
  startsAt: Date;
  endsAt: Date;
  gelRate?: string;
}

export async function insert(pool: Pool, input: NewAuctionInput): Promise<Auction> {
  const { rows } = await pool.query<Auction>(
    `insert into auctions
       (vehicle_id, created_by, status, starting_price, reserve_price, current_price,
        starts_at, ends_at, gel_rate)
     values ($1, $2, 'scheduled', $3, $4, $3, $5, $6, $7)
     returning *`,
    [
      input.vehicleId,
      input.createdBy,
      input.startingPrice,
      input.reservePrice,
      input.startsAt,
      input.endsAt,
      input.gelRate ?? null,
    ],
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

// Team-only view: includes max_amount, ip_address, user_agent.
// CLAUDE.md rule 3 — never return these outside this path.
export async function listBidsFull(pool: Pool, auctionId: string) {
  const { rows } = await pool.query(
    "select * from bids where auction_id = $1 order by created_at asc",
    [auctionId],
  );
  return rows;
}

// Public view — explicitly selects only the columns anyone may see.
export async function listBidsPublic(pool: Pool, auctionId: string) {
  const { rows } = await pool.query(
    `select id, auction_id, bidder_id, amount, is_proxy, created_at
       from bids
      where auction_id = $1
      order by amount desc, created_at asc`,
    [auctionId],
  );
  return rows;
}

export async function cancel(pool: Pool, auctionId: string): Promise<Auction | null> {
  const { rows } = await pool.query<Auction>(
    `update auctions set status = 'cancelled'
      where id = $1 and status not in ('sold', 'unsold')
      returning *`,
    [auctionId],
  );
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
export async function reassignSale(
  pool: Pool,
  auctionId: string,
  newSoldTo: string,
): Promise<Auction | null> {
  // Found by a test, not a pentest: if newSoldTo has no bid on this
  // auction, the old version of this query set sold_to anyway while the
  // final_price subquery returned null — violating the auctions_sold CHECK
  // constraint (status = 'sold' requires both non-null) and surfacing as a
  // raw, uncaught Postgres error (23514) instead of a clean 409. Requiring
  // the bid to exist in the WHERE clause itself means "no matching bid"
  // just yields zero rows, which the service layer already turns into a
  // clean cannot_reassign error.
  const { rows } = await pool.query<Auction>(
    `with target_bid as (
       select amount from bids
        where auction_id = $1 and bidder_id = $2
        order by amount desc
        limit 1
     )
     update auctions
        set sold_to = $2,
            final_price = (select amount from target_bid)
      where id = $1
        and status = 'sold'
        and exists (select 1 from target_bid)
      returning *`,
    [auctionId, newSoldTo],
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
  const { rows: candidates } = await client.query<Auction>(
    `select * from auctions
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

    const reserveMet =
      auction.reserve_price === null ||
      Number(auction.current_price) >= Number(auction.reserve_price);

    if (reserveMet) {
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
