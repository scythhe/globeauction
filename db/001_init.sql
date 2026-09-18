-- 001_init.sql
-- Auction platform: initial schema
-- Postgres 16
--
-- Phase 1 (~3 months): company-owned inventory only, one lot per week,
-- reserve mandatory. Dealer-facing structures exist but are unused.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------

create type user_role as enum ('team', 'dealer', 'buyer');

create type vehicle_status as enum (
  'draft',      -- being filled in
  'pending',    -- submitted, waiting for team approval (phase 2)
  'approved',   -- can be put on auction
  'rejected'
);

create type auction_status as enum (
  'scheduled',        -- created, not open yet
  'live',             -- accepting bids
  'pending_seller',   -- ended below reserve, seller must accept / decline / counter
  'counter_offered',  -- seller countered, waiting on the high bidder (phase 2)
  'sold',
  'unsold',           -- no bids, seller declined, or an offer expired
  'cancelled'
);

-- Retained for salvage lots. Phase 1 inventory is customs-cleared retail
-- stock, so these stay 'unknown' / null.
create type run_status as enum ('run_and_drive', 'starts', 'not_ready', 'unknown');
create type title_status as enum ('clean', 'salvage', 'rebuilt', 'bill_of_sale', 'unknown');

-- ---------------------------------------------------------------
-- organizations
--
-- Exists so self-bidding is blocked at company level, not user level.
-- A dealer with a second account is still blocked.
-- ---------------------------------------------------------------

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- users
-- ---------------------------------------------------------------

create table users (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null unique,
  password_hash       text not null,
  role                user_role not null,
  full_name           text not null,
  phone               text,

  organization_id     uuid references organizations(id),

  -- verification. Manual in phase 1: team calls the buyer, takes a bank
  -- transfer, then enables bidding by hand.
  phone_verified      boolean not null default false,
  id_document_number  text,
  deposit_amount      numeric(12,2),
  deposit_received_at timestamptz,

  -- Bidding is off by default. bid_limit caps total exposure, set from
  -- the deposit (convention: limit = deposit x 10).
  can_bid             boolean not null default false,
  bid_limit           numeric(12,2),
  bid_enabled_by      uuid references users(id),
  bid_enabled_at      timestamptz,

  is_active           boolean not null default true,
  external_id         text,               -- id in the existing company system
  source              text,               -- e.g. 'globmarket'
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint users_bid_limit_positive check (bid_limit is null or bid_limit > 0)
);

create index users_org_idx on users (organization_id);

create unique index users_external_id_key
  on users (source, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------
-- vehicles
--
-- Field set follows globmarket.ge listings: customs-cleared retail cars,
-- not salvage. Damage / title fields are kept nullable for later.
-- ---------------------------------------------------------------

create table vehicles (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references users(id),
  status              vehicle_status not null default 'draft',

  -- identity
  vin                 text,
  make                text not null,
  model               text not null,
  year                integer not null,
  body_style          text,               -- სედანი / ჯიპი / კროსოვერი
  color               text,

  -- drivetrain
  engine_volume       numeric(3,1),       -- litres, e.g. 2.5
  cylinders           integer,
  fuel_type           text,               -- ბენზინი / ჰიბრიდი / ელექტრო / დიზელი
  transmission        text,
  drive_type          text,               -- FWD / RWD / AWD / 4x4
  doors               text,               -- '4/5'
  steering_side       text,               -- 'left' / 'right'
  airbag_count        integer,

  -- interior
  interior_color      text,
  interior_material   text,

  -- odometer
  mileage             integer,
  mileage_unit        text not null default 'km',
  odometer_accurate   boolean,

  -- Georgian market status. These decide whether a car is sellable here.
  customs_cleared     boolean not null default false,   -- განბაჟებული
  tech_inspection     boolean,                          -- ტექ. დათვალიერება
  catalytic_converter boolean,                          -- კატალიზატორი

  -- equipment list, e.g. ["climate_control","sunroof","heated_seats"]
  features            jsonb not null default '[]'::jsonb,

  -- condition. Unused for retail stock; present for salvage lots later.
  damage_primary      text,
  damage_secondary    text,
  run                 run_status not null default 'unknown',
  has_keys            boolean,
  airbags_deployed    boolean,
  title               title_status not null default 'unknown',
  title_country       text,
  condition_notes     text,

  location            text,               -- თბილისი
  description         text,

  reviewed_by         uuid references users(id),
  reviewed_at         timestamptz,
  reject_reason       text,

  external_id         text,               -- globmarket /auto/:id
  source              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint vehicles_year_sane     check (year between 1900 and 2100),
  constraint vehicles_mileage_sane  check (mileage is null or mileage >= 0),
  constraint vehicles_mileage_unit  check (mileage_unit in ('mi', 'km')),
  constraint vehicles_steering      check (steering_side is null or steering_side in ('left', 'right')),
  constraint vehicles_features_arr  check (jsonb_typeof(features) = 'array')
);

create index vehicles_owner_idx    on vehicles (owner_id);
create index vehicles_status_idx   on vehicles (status);
create index vehicles_search_idx   on vehicles (make, model, year);
create index vehicles_features_idx on vehicles using gin (features);

create unique index vehicles_external_id_key
  on vehicles (source, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------
-- vehicle photos
-- ---------------------------------------------------------------

create table vehicle_photos (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  url         text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index vehicle_photos_vehicle_idx
  on vehicle_photos (vehicle_id, sort_order);

-- ---------------------------------------------------------------
-- auctions
--
-- All money is GEL, the working currency (BACKEND_SPEC.md §10 — revised
-- from this table's original USD-first design). gel_rate is recorded per
-- auction so a USD-equivalent can be shown alongside the GEL price at the
-- rate that applied at the time. Display only — never used in bid maths.
-- ---------------------------------------------------------------

create table auctions (
  id                 uuid primary key default gen_random_uuid(),
  vehicle_id         uuid not null references vehicles(id),
  created_by         uuid not null references users(id),
  status             auction_status not null default 'scheduled',

  starting_price     numeric(12,2) not null,
  reserve_price      numeric(12,2),
  current_price      numeric(12,2) not null,  -- denormalised high bid, kept by the bid function
  high_bid_id        uuid,                    -- fk added after bids table exists

  gel_rate           numeric(10,4),           -- GEL per 1 USD, display only

  -- percentage the buyer pays on top of the hammer price.
  -- null until the company decides its fee model.
  buyer_fee_percent  numeric(5,2),

  -- set when status becomes 'sold'. Differs from current_price if the
  -- sale went through a counteroffer.
  final_price        numeric(12,2),
  sold_to            uuid references users(id),
  sold_at            timestamptz,

  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  soft_close_window  interval not null default '2 minutes',

  seller_decision_by timestamptz,             -- deadline while status = pending_seller

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint auctions_window   check (ends_at > starts_at),
  constraint auctions_prices   check (starting_price > 0),
  constraint auctions_reserve  check (reserve_price is null or reserve_price >= starting_price),
  constraint auctions_fee      check (buyer_fee_percent is null or buyer_fee_percent >= 0),
  constraint auctions_sold     check (
    status <> 'sold' or (final_price is not null and sold_to is not null)
  ),

  -- PHASE 1 SAFETY RULE.
  -- Every lot must carry a reserve at the normal listing price, so an
  -- auction can only ever beat what the company would have sold for.
  -- Drop this constraint when opening to third-party sellers.
  constraint auctions_phase1_reserve_required check (reserve_price is not null)
);

-- one open auction per vehicle at a time
create unique index auctions_one_open_per_vehicle
  on auctions (vehicle_id)
  where status in ('scheduled', 'live', 'pending_seller', 'counter_offered');

create index auctions_status_ends_idx on auctions (status, ends_at);
create index auctions_vehicle_idx     on auctions (vehicle_id);

-- ---------------------------------------------------------------
-- bids
-- ---------------------------------------------------------------

create table bids (
  id          uuid primary key default gen_random_uuid(),
  auction_id  uuid not null references auctions(id),
  bidder_id   uuid not null references users(id),

  amount      numeric(12,2) not null,  -- what this bid stands at
  max_amount  numeric(12,2),           -- proxy ceiling; never exposed to other users
  is_proxy    boolean not null default false,

  -- audit. Never returned by a public endpoint. Exists so a shill-bidding
  -- accusation can be investigated rather than argued about.
  ip_address  inet,
  user_agent  text,

  created_at  timestamptz not null default now(),

  constraint bids_amount_positive check (amount > 0),
  constraint bids_max_gte_amount  check (max_amount is null or max_amount >= amount)
);

create index bids_auction_amount_idx on bids (auction_id, amount desc, created_at asc);
create index bids_bidder_idx         on bids (bidder_id);

alter table auctions
  add constraint auctions_high_bid_fk
  foreign key (high_bid_id) references bids(id);

-- ---------------------------------------------------------------
-- counteroffers  (phase 2 — unused while the company is the only seller)
-- ---------------------------------------------------------------

create table counteroffers (
  id           uuid primary key default gen_random_uuid(),
  auction_id   uuid not null references auctions(id),
  offered_by   uuid not null references users(id),   -- the seller
  offered_to   uuid not null references users(id),   -- the high bidder
  amount       numeric(12,2) not null,
  expires_at   timestamptz not null,

  accepted     boolean,                              -- null = still open
  responded_at timestamptz,

  created_at   timestamptz not null default now(),

  constraint counteroffers_amount check (amount > 0)
);

create unique index counteroffers_one_open_per_auction
  on counteroffers (auction_id)
  where accepted is null;

create index counteroffers_expiry_idx
  on counteroffers (expires_at)
  where accepted is null;

-- ---------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger users_updated_at    before update on users    for each row execute function set_updated_at();
create trigger vehicles_updated_at before update on vehicles for each row execute function set_updated_at();
create trigger auctions_updated_at before update on auctions for each row execute function set_updated_at();
