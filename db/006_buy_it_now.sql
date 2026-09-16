-- 006_buy_it_now.sql
-- Buy It Now: a fixed price that closes the auction instantly. Decided
-- with two constraints from the business:
--   1. buy_now_price must be >= reserve_price — it can never undercut the
--      phase-1 guarantee that a car never sells below listing price.
--   2. It disappears once a real bid exists — once bidding has started,
--      the car is committed to the auction process, not eligible for a
--      bypass anymore.

alter table auctions add column buy_now_price numeric(12,2);

alter table auctions add constraint auctions_buy_now_positive
  check (buy_now_price is null or buy_now_price > 0);

alter table auctions add constraint auctions_buy_now_reserve
  check (buy_now_price is null or reserve_price is null or buy_now_price >= reserve_price);

-- ---------------------------------------------------------------
-- buy_now — the only function that resolves an auction via instant buy.
--
-- Mirrors place_bid()'s locking and validation exactly (same error codes:
-- auction_not_live, account_inactive, bidding_disabled, own_organization)
-- plus two new ones specific to this path: buy_now_not_available (no
-- buy_now_price set) and buy_now_already_bid (a real bid already exists).
--
-- On success, inserts a real bid row at buy_now_price — same audit trail
-- as an ordinary bid, same ip/user_agent capture — and immediately closes
-- the auction as 'sold', bypassing the background job entirely. Returns
-- the updated auctions row (not a bid row, unlike place_bid) since the
-- caller cares about the resulting sale, not just their own bid.
-- ---------------------------------------------------------------

create function buy_now(
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
