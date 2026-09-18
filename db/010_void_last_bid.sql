-- 010_void_last_bid.sql
-- Gap: no way to fix a mistyped max_amount (e.g. 1,250,000 instead of
-- 12,500) short of psql. Decided with the business: void it entirely
-- (soft-delete, not a correction) and have the bidder re-bid — scoped to
-- only the most recent action on a live auction, and only when that
-- action was a genuinely new bid (Case A/C/D), not a Case B ceiling
-- raise (reverting a raise needs its own history tracking this doesn't
-- add yet — a raise-mistake still needs psql for now).
--
-- Mechanism: bids.batch_id groups the row(s) one place_bid() call
-- inserts (Case A: 1 row, Case C/D: 2 rows — the challenger's row and
-- the pushed-party's proxy row). auctions.last_bid_batch_id records
-- whether the *most recent* action is voidable at all: set on Case A/C/D,
-- cleared to null on Case B. A null last_bid_batch_id is what makes
-- "only the most recent, and only a new bid" enforceable atomically, with
-- no race between checking and acting — it's read and cleared inside the
-- same FOR UPDATE-locked transaction as everything else in place_bid().
--
-- Voided bids are soft-deleted (voided_at/voided_by), not hard-deleted —
-- same reasoning as auction_events (db/009): the mistake itself is part
-- of the auction's real history, and erasing it outright would undo
-- exactly the kind of audit trail that migration just added. Voided rows
-- are excluded from current_price/high_bid_id (recomputed from whichever
-- bids remain — same highest-amount/earliest-time rule Case E already
-- uses, so no extra "previous state" bookkeeping is needed) and from
-- listBids for everyone, team included — a voided bid never happened as
-- far as standings go; auction_events is where its history actually lives.

alter table bids add column batch_id uuid;
alter table bids add column voided_at timestamptz;
alter table bids add column voided_by uuid references users(id);

alter table auctions add column last_bid_batch_id uuid;

alter table auction_events drop constraint auction_events_event_type_check;
alter table auction_events add constraint auction_events_event_type_check
  check (event_type in ('cancelled', 'reassigned', 'bid_voided'));

create or replace function place_bid(
  p_auction_id  uuid,
  p_bidder_id   uuid,
  p_max_amount  numeric,
  p_ip_address  inet default null,
  p_user_agent  text default null
) returns bids
language plpgsql
as $$
declare
  v_auction     auctions%rowtype;
  v_vehicle     vehicles%rowtype;
  v_bidder      users%rowtype;
  v_owner_org   uuid;
  v_high        bids%rowtype;
  v_min         numeric;
  v_increment   numeric;
  v_new_amount  numeric;
  v_result      bids%rowtype;
  v_now         timestamptz := now();
  v_new_ends_at timestamptz;
  v_batch_id    uuid;
begin
  select * into v_auction from auctions where id = p_auction_id for update;

  if not found
     or v_auction.status <> 'live'
     or v_now < v_auction.starts_at
     or v_now >= v_auction.ends_at
  then
    raise exception 'auction_not_live';
  end if;

  select * into v_bidder from users where id = p_bidder_id;

  if not found or not v_bidder.is_active then
    raise exception 'account_inactive';
  end if;

  if v_bidder.role not in ('dealer', 'buyer') or not v_bidder.can_bid then
    raise exception 'bidding_disabled';
  end if;

  select * into v_vehicle from vehicles where id = v_auction.vehicle_id;
  select organization_id into v_owner_org from users where id = v_vehicle.owner_id;

  if v_bidder.id = v_vehicle.owner_id
     or (v_bidder.organization_id is not null and v_bidder.organization_id = v_owner_org)
  then
    raise exception 'own_organization';
  end if;

  if v_bidder.bid_limit is not null and p_max_amount > v_bidder.bid_limit then
    raise exception 'bid_limit_exceeded'
      using detail = json_build_object('bid_limit', v_bidder.bid_limit)::text;
  end if;

  v_increment := bid_increment(v_auction.current_price);

  if v_auction.high_bid_id is null then
    v_min := v_auction.starting_price;
  else
    v_min := v_auction.current_price + v_increment;
  end if;

  if p_max_amount < v_min then
    raise exception 'bid_too_low'
      using detail = json_build_object(
        'minimum', v_min,
        'current_price', v_auction.current_price
      )::text;
  end if;

  if v_auction.high_bid_id is not null then
    select * into v_high from bids where id = v_auction.high_bid_id;
  end if;

  -- Case B: the new bidder already holds the high bid — raise their ceiling.
  -- Must be strictly higher than their existing max_amount, or it isn't a
  -- raise: reject with the same bid_too_low shape the generic floor uses,
  -- but with their own ceiling as the minimum.
  --
  -- Not voidable: last_bid_batch_id is explicitly cleared, since a raise
  -- doesn't create a new row for void_last_bid() to remove.
  if v_high.id is not null and v_high.bidder_id = p_bidder_id then
    if p_max_amount <= v_high.max_amount then
      raise exception 'bid_too_low'
        using detail = json_build_object(
          'minimum', v_high.max_amount,
          'current_price', v_auction.current_price
        )::text;
    end if;

    update bids
      set max_amount = p_max_amount,
          ip_address = coalesce(p_ip_address, ip_address),
          user_agent = coalesce(p_user_agent, user_agent)
      where id = v_high.id
      returning * into v_result;

    update auctions set last_bid_batch_id = null where id = p_auction_id;

  -- Case A: no existing bid.
  elsif v_auction.high_bid_id is null then
    v_batch_id := gen_random_uuid();

    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent, batch_id)
    values (p_auction_id, p_bidder_id, v_auction.starting_price, p_max_amount, false, p_ip_address, p_user_agent, v_batch_id)
    returning * into v_result;

    update auctions
      set current_price = v_auction.starting_price,
          high_bid_id   = v_result.id,
          last_bid_batch_id = v_batch_id
      where id = p_auction_id;

  -- Case C: new max_amount > H.max_amount — new bidder takes the lead.
  elsif p_max_amount > v_high.max_amount then
    v_batch_id := gen_random_uuid();

    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, batch_id)
    values (p_auction_id, v_high.bidder_id, v_high.max_amount, v_high.max_amount, true, v_batch_id);

    v_new_amount := least(v_high.max_amount + v_increment, p_max_amount);

    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent, batch_id)
    values (p_auction_id, p_bidder_id, v_new_amount, p_max_amount, false, p_ip_address, p_user_agent, v_batch_id)
    returning * into v_result;

    update auctions
      set current_price = v_new_amount,
          high_bid_id   = v_result.id,
          last_bid_batch_id = v_batch_id
      where id = p_auction_id;

  -- Case D (and E, the tie): new max_amount <= H.max_amount. Old holder retains the lead.
  else
    v_batch_id := gen_random_uuid();

    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent, batch_id)
    values (p_auction_id, p_bidder_id, p_max_amount, p_max_amount, false, p_ip_address, p_user_agent, v_batch_id)
    returning * into v_result;

    v_new_amount := least(p_max_amount + v_increment, v_high.max_amount);

    declare
      v_proxy bids%rowtype;
    begin
      insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, batch_id)
      values (p_auction_id, v_high.bidder_id, v_new_amount, v_high.max_amount, true, v_batch_id)
      returning * into v_proxy;

      update auctions
        set current_price = v_new_amount,
            high_bid_id   = v_proxy.id,
            last_bid_batch_id = v_batch_id
        where id = p_auction_id;
    end;
  end if;

  if v_auction.ends_at - v_now < v_auction.soft_close_window then
    v_new_ends_at := v_now + v_auction.soft_close_window;
    update auctions set ends_at = v_new_ends_at where id = p_auction_id;
  end if;

  update auctions set updated_at = now() where id = p_auction_id;

  return v_result;
end;
$$;

-- void_last_bid(): team-only (enforced in the service layer, same as
-- cancel/reassignSale). Requires the auction to be 'live' and
-- last_bid_batch_id to be set (the most recent action was a genuinely
-- new bid, not a raise, and nothing has voided it already).
create or replace function void_last_bid(
  p_auction_id uuid,
  p_actor_id   uuid
) returns auctions
language plpgsql
as $$
declare
  v_auction     auctions%rowtype;
  v_batch_id    uuid;
  v_voided_ids  uuid[];
  v_new_high    bids%rowtype;
  v_detail      jsonb;
begin
  select * into v_auction from auctions where id = p_auction_id for update;

  if not found or v_auction.status <> 'live' then
    raise exception 'auction_not_live';
  end if;

  v_batch_id := v_auction.last_bid_batch_id;

  if v_batch_id is null then
    raise exception 'bid_not_voidable';
  end if;

  -- Snapshot what's being voided, for the audit-trail entry, before
  -- touching anything.
  select jsonb_build_object(
           'bidder_id', bidder_id,
           'amount', amount,
           'max_amount', max_amount
         )
    into v_detail
    from bids
   where batch_id = v_batch_id and is_proxy = false
   limit 1;

  with voided as (
    update bids
       set voided_at = now(),
           voided_by = p_actor_id
     where batch_id = v_batch_id
       and voided_at is null
     returning id
  )
  select array_agg(id) into v_voided_ids from voided;

  -- Recompute standings from whatever's left — same highest-amount,
  -- earliest-time rule Case E already uses. No remaining bids means back
  -- to the pre-auction state.
  select * into v_new_high
    from bids
   where auction_id = p_auction_id and voided_at is null
   order by amount desc, created_at asc
   limit 1;

  if found then
    update auctions
       set current_price = v_new_high.amount,
           high_bid_id   = v_new_high.id,
           last_bid_batch_id = v_new_high.batch_id
     where id = p_auction_id
     returning * into v_auction;
  else
    update auctions
       set current_price = v_auction.starting_price,
           high_bid_id   = null,
           last_bid_batch_id = null
     where id = p_auction_id
     returning * into v_auction;
  end if;

  insert into auction_events (auction_id, event_type, actor_id, detail)
  values (
    p_auction_id, 'bid_voided', p_actor_id,
    coalesce(v_detail, '{}'::jsonb) || jsonb_build_object('voided_bid_ids', to_jsonb(v_voided_ids))
  );

  return v_auction;
end;
$$;
