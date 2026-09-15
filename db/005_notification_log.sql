-- 005_notification_log.sql
-- Tracks which notifications have already been generated, so the
-- background job (§8) can run every 30 seconds without re-sending the same
-- outbid/ending-soon/reserve-not-met notice on every tick.
--
-- BACKEND_SPEC.md §9: "Send from a job, not inline in the bid transaction.
-- A failing mail server must never roll back a bid." This table is what
-- lets the job be idempotent instead of relying on in-memory state that
-- would reset on every restart.

create type notification_kind as enum ('outbid', 'ending_soon', 'reserve_not_met');

create table notification_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id),
  kind         notification_kind not null,
  auction_id   uuid references auctions(id),
  bid_id       uuid references bids(id),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

-- 'outbid' fires once per proxy bid (the event that pushed someone down).
create unique index notification_log_outbid_once
  on notification_log (bid_id)
  where kind = 'outbid';

-- 'ending_soon' fires once per (auction, bidder) pair.
create unique index notification_log_ending_soon_once
  on notification_log (auction_id, user_id)
  where kind = 'ending_soon';

-- 'reserve_not_met' fires once per auction (to the seller — team, in phase 1).
create unique index notification_log_reserve_not_met_once
  on notification_log (auction_id)
  where kind = 'reserve_not_met';

create index notification_log_unsent_idx
  on notification_log (kind)
  where sent_at is null;
