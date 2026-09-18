-- 009_auction_events.sql
-- Audit trail gap: reassignSale() overwrote sold_to/final_price in place
-- with no record of the original winner, and cancel() just flipped status
-- with no record of why or who. Both are routine, expected parts of the
-- process (§7's non-payment reassignment isn't an edge case), so losing
-- that history on every use was a real gap, not a hypothetical one.
--
-- auction_events is intentionally narrow — it logs the two state changes
-- identified as gaps (cancelled, reassigned), not a general-purpose audit
-- framework for every mutation in the system. bids themselves are already
-- an immutable audit trail; this covers the two places where a row gets
-- overwritten instead of appended.

create table auction_events (
  id          uuid primary key default gen_random_uuid(),
  auction_id  uuid not null references auctions(id),
  event_type  text not null check (event_type in ('cancelled', 'reassigned')),
  actor_id    uuid not null references users(id),
  occurred_at timestamptz not null default now(),
  detail      jsonb not null default '{}'::jsonb
);

create index auction_events_auction_idx on auction_events (auction_id, occurred_at);

-- Both functions below log in the same statement as the state change
-- itself (via a data-modifying CTE), not a separate query after — an
-- event logged for a change that didn't actually happen (or a change
-- that happened with no event logged) is worse than not having the log
-- at all.

create or replace function cancel_auction(
  p_auction_id uuid,
  p_actor_id   uuid
) returns setof auctions
-- setof, not a bare `auctions`: a plain (non-setof) `language sql`
-- function whose body query yields zero rows still returns one row of
-- all-NULL columns, not zero rows — confirmed directly. The repository
-- layer relies on "zero rows means the guard rejected it" (rows[0] ??
-- null), so a bare return type would silently turn every rejection into
-- a fake auction full of nulls instead of null itself.
language sql
as $$
  -- No FOR UPDATE here: a read-only CTE with FOR UPDATE combined with
  -- another CTE that updates the same row, in the same WITH, sees no row
  -- at all under READ COMMITTED (confirmed directly — this isn't a
  -- documented gotcha, just an observed one). Row locking for the actual
  -- change is already provided by `updated`'s own UPDATE; `old` only
  -- needs the pre-statement snapshot value, which a plain read gives it.
  with old as (
    select status from auctions where id = p_auction_id
  ),
  updated as (
    update auctions
       set status = 'cancelled'
     where id = p_auction_id
       and status not in ('sold', 'unsold')
    returning *
  ),
  logged as (
    insert into auction_events (auction_id, event_type, actor_id, detail)
    select p_auction_id, 'cancelled', p_actor_id,
           jsonb_build_object('previous_status', (select status from old))
      from updated
    returning 1
  )
  select * from updated;
$$;

create or replace function reassign_sale(
  p_auction_id uuid,
  p_new_sold_to uuid,
  p_actor_id   uuid
) returns setof auctions
-- setof — see cancel_auction() above for why.
language sql
as $$
  -- See cancel_auction() above: no FOR UPDATE here, same reason.
  with old as (
    select sold_to, final_price from auctions where id = p_auction_id
  ),
  target_bid as (
    select amount from bids
     where auction_id = p_auction_id and bidder_id = p_new_sold_to
     order by amount desc
     limit 1
  ),
  updated as (
    update auctions
       set sold_to = p_new_sold_to,
           final_price = (select amount from target_bid)
     where id = p_auction_id
       and status = 'sold'
       and exists (select 1 from target_bid)
    returning *
  ),
  logged as (
    insert into auction_events (auction_id, event_type, actor_id, detail)
    select p_auction_id, 'reassigned', p_actor_id,
           jsonb_build_object(
             'previous_sold_to', (select sold_to from old),
             'previous_final_price', (select final_price from old),
             'new_sold_to', p_new_sold_to,
             'new_final_price', (select amount from target_bid)
           )
      from updated
    returning 1
  )
  select * from updated;
$$;
