import type { PoolClient } from "pg";

export type NotificationKind = "outbid" | "ending_soon" | "reserve_not_met";

// --- outbid: one row per proxy bid, the event that pushed someone down ---

export interface OutbidCandidate {
  bid_id: string;
  bidder_id: string;
  email: string;
  full_name: string;
  auction_id: string;
}

// is_proxy = true marks a system-generated row, not "this bidder was
// outbid" — BACKEND_SPEC.md §5.3 Case D inserts the still-leading
// bidder's own updated proxy row the same way Case C inserts the
// genuinely-outbid old leader's. The two are told apart by whether the
// row is the auction's *current* high bid: Case D's is, Case C's isn't.
// Excluding `a.high_bid_id` is what keeps the still-winning bidder from
// getting an "outbid" email every time someone bids under their ceiling.
export async function findUnnotifiedOutbids(client: PoolClient): Promise<OutbidCandidate[]> {
  const { rows } = await client.query<OutbidCandidate>(
    `select b.id as bid_id, b.bidder_id, u.email, u.full_name, b.auction_id
       from bids b
       join users u on u.id = b.bidder_id
       join auctions a on a.id = b.auction_id
      where b.is_proxy = true
        and b.id is distinct from a.high_bid_id
        and not exists (
          select 1 from notification_log n
           where n.kind = 'outbid' and n.bid_id = b.id
        )`,
  );
  return rows;
}

// --- ending_soon: one row per (auction, bidder) for auctions closing within an hour ---

export interface EndingSoonCandidate {
  auction_id: string;
  bidder_id: string;
  email: string;
  full_name: string;
  ends_at: Date;
}

export async function findUnnotifiedEndingSoon(client: PoolClient): Promise<EndingSoonCandidate[]> {
  const { rows } = await client.query<EndingSoonCandidate>(
    `select distinct b.auction_id, b.bidder_id, u.email, u.full_name, a.ends_at
       from bids b
       join auctions a on a.id = b.auction_id
       join users u on u.id = b.bidder_id
      where a.status = 'live'
        and a.ends_at <= now() + interval '1 hour'
        and a.ends_at > now()
        and not exists (
          select 1 from notification_log n
           where n.kind = 'ending_soon'
             and n.auction_id = b.auction_id
             and n.user_id = b.bidder_id
        )`,
  );
  return rows;
}

// --- reserve_not_met: one row per auction that just landed in pending_seller ---

export interface ReserveNotMetCandidate {
  auction_id: string;
  seller_id: string;
  email: string;
  full_name: string;
  current_price: string;
  reserve_price: string;
}

export async function findUnnotifiedReserveNotMet(
  client: PoolClient,
): Promise<ReserveNotMetCandidate[]> {
  // In phase 1 the seller is always the vehicle's owner (team) — see
  // BACKEND_SPEC.md §1, §6.
  const { rows } = await client.query<ReserveNotMetCandidate>(
    `select a.id as auction_id, v.owner_id as seller_id, u.email, u.full_name,
            a.current_price, a.reserve_price
       from auctions a
       join vehicles v on v.id = a.vehicle_id
       join users u on u.id = v.owner_id
      where a.status = 'pending_seller'
        and not exists (
          select 1 from notification_log n
           where n.kind = 'reserve_not_met' and n.auction_id = a.id
        )`,
  );
  return rows;
}

// --- logging + marking sent ---

export async function logPending(
  client: PoolClient,
  kind: NotificationKind,
  userId: string,
  auctionId: string,
  bidId: string | null = null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into notification_log (user_id, kind, auction_id, bid_id)
     values ($1, $2, $3, $4)
     returning id`,
    [userId, kind, auctionId, bidId],
  );
  return rows[0]!.id;
}

export async function markSent(client: PoolClient, id: string): Promise<void> {
  await client.query("update notification_log set sent_at = now() where id = $1", [id]);
}
