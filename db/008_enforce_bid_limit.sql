-- 008_enforce_bid_limit.sql
-- BACKEND_SPEC.md §2.1: "bid_limit caps total exposure; convention is
-- deposit_amount × 10." users.bid_limit was computed on every deposit and
-- shown in the admin UI, but neither place_bid() nor buy_now() ever read
-- it — a bidder with the 500₾ minimum deposit (bid_limit 5,000₾) could
-- submit max_amount: 5,000,000 with nothing stopping them. Found by
-- review, not a pentest.
--
-- Phase 1 runs one live auction at a time (CLAUDE.md: "One lot per week"),
-- so a per-bid ceiling against p_max_amount *is* total exposure in
-- practice — there's never a second live auction to also be exposed to.
-- Enforced on every branch that accepts a fresh p_max_amount (Case A/B/C/D
-- all funnel through the same validation step, before the case dispatch),
-- and equivalently in buy_now() against buy_now_price. A null bid_limit
-- (shouldn't occur via the app's own enableBidding, which requires a
-- deposit to already be recorded — but isn't itself impossible in the
-- schema) is treated as no ceiling, consistent with how a null
-- organization_id is treated elsewhere in this function.

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

  -- Case A: no existing bid.
  elsif v_auction.high_bid_id is null then
    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent)
    values (p_auction_id, p_bidder_id, v_auction.starting_price, p_max_amount, false, p_ip_address, p_user_agent)
    returning * into v_result;

    update auctions
      set current_price = v_auction.starting_price,
          high_bid_id   = v_result.id
      where id = p_auction_id;

  -- Case C: new max_amount > H.max_amount — new bidder takes the lead.
  elsif p_max_amount > v_high.max_amount then
    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy)
    values (p_auction_id, v_high.bidder_id, v_high.max_amount, v_high.max_amount, true);

    v_new_amount := least(v_high.max_amount + v_increment, p_max_amount);

    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent)
    values (p_auction_id, p_bidder_id, v_new_amount, p_max_amount, false, p_ip_address, p_user_agent)
    returning * into v_result;

    update auctions
      set current_price = v_new_amount,
          high_bid_id   = v_result.id
      where id = p_auction_id;

  -- Case D (and E, the tie): new max_amount <= H.max_amount. Old holder retains the lead.
  else
    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent)
    values (p_auction_id, p_bidder_id, p_max_amount, p_max_amount, false, p_ip_address, p_user_agent)
    returning * into v_result;

    v_new_amount := least(p_max_amount + v_increment, v_high.max_amount);

    declare
      v_proxy bids%rowtype;
    begin
      insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy)
      values (p_auction_id, v_high.bidder_id, v_new_amount, v_high.max_amount, true)
      returning * into v_proxy;

      update auctions
        set current_price = v_new_amount,
            high_bid_id   = v_proxy.id
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

create or replace function buy_now(
  p_auction_id  uuid,
  p_bidder_id   uuid,
  p_ip_address  inet default null,
  p_user_agent  text default null
) returns auctions
language plpgsql
as $$
declare
  v_auction   auctions%rowtype;
  v_vehicle   vehicles%rowtype;
  v_bidder    users%rowtype;
  v_owner_org uuid;
  v_bid       bids%rowtype;
  v_now       timestamptz := now();
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

  if v_auction.buy_now_price is null then
    raise exception 'buy_now_not_available';
  end if;

  if v_auction.high_bid_id is not null then
    raise exception 'buy_now_already_bid';
  end if;

  if v_bidder.bid_limit is not null and v_auction.buy_now_price > v_bidder.bid_limit then
    raise exception 'bid_limit_exceeded'
      using detail = json_build_object('bid_limit', v_bidder.bid_limit)::text;
  end if;

  insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent)
  values (p_auction_id, p_bidder_id, v_auction.buy_now_price, v_auction.buy_now_price, false, p_ip_address, p_user_agent)
  returning * into v_bid;

  update auctions
     set current_price = v_auction.buy_now_price,
         high_bid_id   = v_bid.id,
         status        = 'sold',
         final_price   = v_auction.buy_now_price,
         sold_to       = p_bidder_id,
         sold_at       = v_now,
         updated_at    = v_now
   where id = p_auction_id
   returning * into v_auction;

  return v_auction;
end;
$$;
