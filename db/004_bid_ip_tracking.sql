-- 004_bid_ip_tracking.sql
-- place_bid() never captured ip_address/user_agent, despite BACKEND_SPEC.md
-- §5.1 existing specifically so a shill-bidding accusation can be
-- investigated. Redefines the function (CREATE OR REPLACE, new migration —
-- 002 stays untouched) to accept and record them on the calling bidder's
-- own row. Both are optional (default null) so existing callers/tests
-- don't break.
--
-- Proxy rows inserted on behalf of the *other* party (the one being pushed
-- up, not the one calling place_bid this time) intentionally get null
-- ip/user_agent — that's the system acting automatically, not a fresh
-- request from that person.

-- CREATE OR REPLACE does not replace a function whose parameter list
-- differs — Postgres treats it as a distinct overload, which would leave
-- the old 3-arg place_bid callable (and ambiguous against this one's
-- defaulted params) unless dropped explicitly first.
drop function if exists place_bid(uuid, uuid, numeric);

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
    insert into bids (auction_id, bidder_id, amount, max_amount, is_proxy, ip_address, user_agent)
    values (p_auction_id, p_bidder_id, v_auction.starting_price, p_max_amount, false, p_ip_address, p_user_agent)
    returning * into v_result;

    update auctions
      set current_price = v_auction.starting_price,
          high_bid_id   = v_result.id
      where id = p_auction_id;

  -- Case B: the new bidder already holds the high bid — raise their ceiling.
  elsif v_high.bidder_id = p_bidder_id then
    update bids
      set max_amount = p_max_amount,
          ip_address = coalesce(p_ip_address, ip_address),
          user_agent = coalesce(p_user_agent, user_agent)
      where id = v_high.id
      returning * into v_result;

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
