-- 013_pre_bidding.sql
-- Pre-bidding: a bidder can place a max (proxy) bid on a 'scheduled'
-- auction before it goes live, same as Copart's own pre-bid window. It
-- runs through the exact same Case A-E proxy resolution as a live bid —
-- if two people pre-bid, the one who arrives second and outbids the
-- first is resolved via the ordinary proxy mechanism, so by the time
-- openScheduledAuctions() flips the row to 'live' at starts_at, current
-- price/high_bid_id already reflect whatever pre-bid competition happened,
-- exactly as if those bids had landed the instant the lot opened.
--
-- The only change is the guard at the top: allow 'scheduled' in addition
-- to 'live', and drop the "must be after starts_at" check entirely (that
-- check existed purely to reject pre-bids, which is exactly what this
-- migration is un-doing). The ends_at upper bound stays — a 'scheduled'
-- auction is always well before its own ends_at by construction, so this
-- doesn't loosen anything at the close end.

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
     or v_auction.status not in ('live', 'scheduled')
     -- A 'live' row with starts_at still in the future shouldn't exist
     -- (openScheduledAuctions only flips scheduled -> live once
     -- starts_at <= now()), but this guard predates that job and is kept
     -- as defense in depth against a corrupted/manually-edited row.
     -- 'scheduled' has no such lower bound — that's the entire point of
     -- pre-bidding, so it's deliberately absent from this branch.
     or (v_auction.status = 'live' and v_now < v_auction.starts_at)
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

  -- Soft close: unaffected by this migration — a 'scheduled' auction's
  -- ends_at is always far past its own starts_at, so this simply never
  -- fires during pre-bidding in practice. Left exactly as db/011 had it.
  if v_auction.ends_at - v_now < v_auction.soft_close_trigger then
    v_new_ends_at := greatest(v_auction.ends_at, v_now + v_auction.soft_close_extension);
    update auctions set ends_at = v_new_ends_at where id = p_auction_id;
  end if;

  update auctions set updated_at = now() where id = p_auction_id;

  return v_result;
end;
$$;
