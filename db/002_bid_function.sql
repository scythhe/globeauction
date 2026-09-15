-- 002_bid_function.sql
-- The bid resolution function. Per CLAUDE.md, this is the only path by which
-- a bid row is created — no other code writes to `bids`.
--
-- Implements BACKEND_SPEC.md §5.3 (cases A-E) and §5.3's soft-close rule.
-- All amounts are GEL per BACKEND_SPEC.md §10.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------
-- bid_increment — minimum step between bids, by current price.
-- BACKEND_SPEC.md §5.2. Lives in SQL for now; move to a table if the
-- brackets start changing.
-- ---------------------------------------------------------------

create or replace function bid_increment(p_price numeric) returns numeric
language sql
immutable
as $$
  select case
    when p_price < 500    then 25
    when p_price < 1000   then 50
    when p_price < 5000   then 100
    when p_price < 10000  then 250
    when p_price < 25000  then 500
    else 1000
  end;
$$;

-- ---------------------------------------------------------------
-- place_bid — the only function that inserts into `bids`.
--
-- Raises one of: auction_not_live, account_inactive, bidding_disabled,
-- own_organization, bid_too_low (matching BACKEND_SPEC.md §12's error
-- codes). bid_too_low carries `minimum` and `current_price` as a JSON
-- object in the exception DETAIL, for the service layer to surface per
-- CLAUDE.md's structured-error convention.
--
-- Returns the calling bidder's own resulting bid row: the row they now
-- hold in `bids`, whether or not it's the current high bid. Callers can
-- tell they're currently leading by comparing the returned row's id to
-- auctions.high_bid_id after the call.
-- ---------------------------------------------------------------

create or replace function place_bid(
  p_auction_id uuid,
  p_bidder_id  uuid,
  p_max_amount numeric
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
  -- Lock the auction row first. Everything below reads state that must
  -- not change under us while we decide the bid (BACKEND_SPEC.md §5.4).
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

  -- Case A: no existing bid.
  if v_auction.high_bid_id is null then
    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy)
    values (p_auction_id, p_bidder_id, v_auction.starting_price, p_max_amount, false)
    returning * into v_result;

    update auctions
      set current_price = v_auction.starting_price,
          high_bid_id   = v_result.id
      where id = p_auction_id;

  -- Case B: the new bidder already holds the high bid — raise their ceiling.
  elsif v_high.bidder_id = p_bidder_id then
    update bids set max_amount = p_max_amount
      where id = v_high.id
      returning * into v_result;
    -- current_price / high_bid_id unchanged.

  -- Case C: new max_amount > H.max_amount — new bidder takes the lead.
  elsif p_max_amount > v_high.max_amount then
    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy)
    values (p_auction_id, v_high.bidder_id, v_high.max_amount, v_high.max_amount, true);

    v_new_amount := least(v_high.max_amount + v_increment, p_max_amount);

    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy)
    values (p_auction_id, p_bidder_id, v_new_amount, p_max_amount, false)
    returning * into v_result;

    update auctions
      set current_price = v_new_amount,
          high_bid_id   = v_result.id
      where id = p_auction_id;

  -- Case D (and E, the tie — earliest created_at wins, i.e. the existing
  -- holder): new max_amount <= H.max_amount. Old holder retains the lead.
  else
    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy)
    values (p_auction_id, p_bidder_id, p_max_amount, p_max_amount, false)
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

  -- Soft close: push ends_at out if this bid landed inside the window.
  if v_auction.ends_at - v_now < v_auction.soft_close_window then
    v_new_ends_at := v_now + v_auction.soft_close_window;
    update auctions set ends_at = v_new_ends_at where id = p_auction_id;
  end if;

  update auctions set updated_at = now() where id = p_auction_id;

  return v_result;
end;
$$;
