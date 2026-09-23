-- 014_flat_bid.sql
-- Monster Bid (and pre-bidding, which shares its logic) is meant to move
-- the visible price straight to the number the bidder dialed in — not act
-- as a hidden proxy ceiling the way Quick Bid does. Today, becoming the
-- new high bidder always shows current_price as "just enough to lead"
-- (starting_price, or the rival's max plus one increment), keeping the
-- bidder's true max_amount concealed even when they explicitly chose to
-- reveal a specific number. Quick Bid still needs that concealment (its
-- whole design is "commit to a private ceiling, let the engine ration out
-- only as much of it as needed"); Monster Bid's whole design is the
-- opposite — publish the number.
--
-- New optional parameter p_flat (default false, so every existing Quick
-- Bid call is untouched): when true, current_price/amount are set to the
-- bidder's own p_max_amount directly in every case where this bid becomes
-- (or already is) the high bid — Cases A, B, C. Case D is deliberately
-- unaffected either way: there the bidder does NOT become the high
-- bidder, and the amount that resolves is the rival's own true ceiling,
-- not this bidder's — a flat Monster Bid still loses to a higher stored
-- max, exactly like a proxy bid would, because someone else's genuine
-- commitment to pay more cannot be overridden by a bidder who was simply
-- willing to say their number out loud.

create or replace function place_bid(
  p_auction_id  uuid,
  p_bidder_id   uuid,
  p_max_amount  numeric,
  p_ip_address  inet default null,
  p_user_agent  text default null,
  p_flat        boolean default false
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
  --
  -- Ordinarily a self-raise never moves current_price (nobody else is
  -- competing, so nothing needs to show yet) — but a flat re-raise is the
  -- bidder explicitly saying "publish my new number now," so current_price
  -- follows it immediately instead of waiting for a rival to force it up.
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
          amount = case when p_flat then p_max_amount else amount end,
          ip_address = coalesce(p_ip_address, ip_address),
          user_agent = coalesce(p_user_agent, user_agent)
      where id = v_high.id
      returning * into v_result;

    update auctions
      set current_price = v_result.amount,
          last_bid_batch_id = null
      where id = p_auction_id;

  -- Case A: no existing bid. A flat bid publishes its own number as the
  -- opening price instead of resting at starting_price.
  elsif v_auction.high_bid_id is null then
    v_batch_id := gen_random_uuid();

    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent, batch_id)
    values (
      p_auction_id, p_bidder_id,
      case when p_flat then p_max_amount else v_auction.starting_price end,
      p_max_amount, false, p_ip_address, p_user_agent, v_batch_id
    )
    returning * into v_result;

    update auctions
      set current_price = v_result.amount,
          high_bid_id   = v_result.id,
          last_bid_batch_id = v_batch_id
      where id = p_auction_id;

  -- Case C: new max_amount > H.max_amount — new bidder takes the lead. A
  -- flat bid shows its own full number instead of the proxy-compressed
  -- "rival's max plus one increment."
  elsif p_max_amount > v_high.max_amount then
    v_batch_id := gen_random_uuid();

    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, batch_id)
    values (p_auction_id, v_high.bidder_id, v_high.max_amount, v_high.max_amount, true, v_batch_id);

    v_new_amount := case
      when p_flat then p_max_amount
      else least(v_high.max_amount + v_increment, p_max_amount)
    end;

    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent, batch_id)
    values (p_auction_id, p_bidder_id, v_new_amount, p_max_amount, false, p_ip_address, p_user_agent, v_batch_id)
    returning * into v_result;

    update auctions
      set current_price = v_new_amount,
          high_bid_id   = v_result.id,
          last_bid_batch_id = v_batch_id
      where id = p_auction_id;

  -- Case D (and E, the tie): new max_amount <= H.max_amount. Old holder
  -- retains the lead. Deliberately untouched by p_flat — the amount that
  -- resolves here belongs to the existing high bidder's own proxy ceiling,
  -- not to this (losing) bidder, so there is nothing of this bidder's to
  -- "reveal." A flat Monster Bid below someone else's real max still loses
  -- to it, same as a proxy bid would.
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

  -- Soft close: unaffected by this migration.
  if v_auction.ends_at - v_now < v_auction.soft_close_trigger then
    v_new_ends_at := greatest(v_auction.ends_at, v_now + v_auction.soft_close_extension);
    update auctions set ends_at = v_new_ends_at where id = p_auction_id;
  end if;

  update auctions set updated_at = now() where id = p_auction_id;

  return v_result;
end;
$$;
