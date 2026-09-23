import { Client, Pool } from "pg";

export function testConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set");
  }
  return url;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: testConnectionString() });
  await client.connect();
  return client;
}

// Service functions take a `Pool`, not a `Client` — fixture setup and
// assertions in tests use the plain Client above, but calling the actual
// service layer (the thing under test) needs a real Pool.
export function testPool(): Pool {
  return new Pool({ connectionString: testConnectionString() });
}

export async function reset(client: Client): Promise<void> {
  await client.query(
    "truncate organizations, users, vehicles, vehicle_photos, auctions, bids, counteroffers restart identity cascade",
  );
}

interface OrgFixture {
  id: string;
}

export async function createOrg(client: Client, name = "Test Org"): Promise<OrgFixture> {
  const { rows } = await client.query(
    "insert into organizations (name) values ($1) returning id",
    [name],
  );
  return rows[0];
}

export interface UserFixture {
  id: string;
}

export async function createUser(
  client: Client,
  overrides: Partial<{
    role: "team" | "dealer" | "buyer";
    organizationId: string | null;
    canBid: boolean;
    isActive: boolean;
    email: string;
    bidLimit: number | null;
  }> = {},
): Promise<UserFixture> {
  const role = overrides.role ?? "buyer";
  const organizationId = overrides.organizationId ?? null;
  const canBid = overrides.canBid ?? true;
  const isActive = overrides.isActive ?? true;
  const email = overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`;
  const bidLimit = overrides.bidLimit === undefined ? null : overrides.bidLimit;

  const { rows } = await client.query(
    `insert into users (email, password_hash, role, full_name, organization_id, can_bid, is_active, bid_limit)
     values ($1, 'x', $2, 'Test User', $3, $4, $5, $6)
     returning id`,
    [email, role, organizationId, canBid, isActive, bidLimit],
  );
  return rows[0];
}

interface VehicleFixture {
  id: string;
}

export async function createVehicle(
  client: Client,
  ownerId: string,
  overrides: Partial<{ status: "draft" | "pending" | "approved" | "rejected" }> = {},
): Promise<VehicleFixture> {
  const status = overrides.status ?? "approved";
  const { rows } = await client.query(
    `insert into vehicles (owner_id, status, make, model, year)
     values ($1, $2, 'Toyota', 'Camry', 2020)
     returning id`,
    [ownerId, status],
  );
  return rows[0];
}

export async function createVehiclePhoto(client: Client, vehicleId: string): Promise<{ id: string }> {
  const { rows } = await client.query(
    `insert into vehicle_photos (vehicle_id, url, sort_order)
     values ($1, 'https://example.test/photo.jpg', coalesce((select max(sort_order) + 1 from vehicle_photos where vehicle_id = $1), 0))
     returning id`,
    [vehicleId],
  );
  return rows[0];
}

interface AuctionFixture {
  id: string;
}

export async function createAuction(
  client: Client,
  vehicleId: string,
  createdBy: string,
  overrides: Partial<{
    startingPrice: number;
    reservePrice: number | null;
    startsAt: Date;
    endsAt: Date;
    softCloseTrigger: string;
    softCloseExtension: string;
    buyNowPrice: number | null;
  }> = {},
): Promise<AuctionFixture> {
  const startingPrice = overrides.startingPrice ?? 1000;
  const reservePrice = overrides.reservePrice === undefined ? startingPrice : overrides.reservePrice;
  const startsAt = overrides.startsAt ?? new Date(Date.now() - 60_000);
  const endsAt = overrides.endsAt ?? new Date(Date.now() + 60 * 60_000);
  const softCloseTrigger = overrides.softCloseTrigger ?? "5 minutes";
  const softCloseExtension = overrides.softCloseExtension ?? "15 seconds";
  const buyNowPrice = overrides.buyNowPrice ?? null;

  const { rows } = await client.query(
    `insert into auctions
       (vehicle_id, created_by, status, starting_price, reserve_price,
        current_price, starts_at, ends_at, soft_close_trigger, soft_close_extension, buy_now_price)
     values ($1, $2, 'live', $3, $4, $3, $5, $6, $7::interval, $8::interval, $9)
     returning id`,
    [
      vehicleId,
      createdBy,
      startingPrice,
      reservePrice,
      startsAt,
      endsAt,
      softCloseTrigger,
      softCloseExtension,
      buyNowPrice,
    ],
  );
  return rows[0];
}

export async function setAuctionStatus(
  client: Client,
  auctionId: string,
  status: string,
  extra: Partial<{
    finalPrice: number;
    soldTo: string;
    sellerDecisionBy: Date;
  }> = {},
) {
  await client.query(
    `update auctions
        set status = $2,
            final_price = coalesce($3, final_price),
            sold_to = coalesce($4, sold_to),
            seller_decision_by = coalesce($5, seller_decision_by)
      where id = $1`,
    [auctionId, status, extra.finalPrice ?? null, extra.soldTo ?? null, extra.sellerDecisionBy ?? null],
  );
}

export async function getAuction(client: Client, auctionId: string) {
  const { rows } = await client.query("select * from auctions where id = $1", [auctionId]);
  return rows[0];
}

export async function getBid(client: Client, bidId: string) {
  const { rows } = await client.query("select * from bids where id = $1", [bidId]);
  return rows[0];
}

export async function listBids(client: Client, auctionId: string) {
  const { rows } = await client.query(
    "select * from bids where auction_id = $1 order by created_at asc",
    [auctionId],
  );
  return rows;
}

export async function placeBid(
  client: Client,
  auctionId: string,
  bidderId: string,
  maxAmount: number,
  ipAddress: string | null = null,
  userAgent: string | null = null,
) {
  const { rows } = await client.query(
    "select * from place_bid($1, $2, $3, $4, $5) as bid",
    [auctionId, bidderId, maxAmount, ipAddress, userAgent],
  );
  return rows[0];
}

export async function voidLastBid(client: Client, auctionId: string, actorId: string) {
  const { rows } = await client.query("select * from void_last_bid($1, $2) as auction", [
    auctionId,
    actorId,
  ]);
  return rows[0];
}

export async function buyNow(
  client: Client,
  auctionId: string,
  bidderId: string,
  ipAddress: string | null = null,
  userAgent: string | null = null,
) {
  const { rows } = await client.query(
    "select * from buy_now($1, $2, $3, $4) as auction",
    [auctionId, bidderId, ipAddress, userAgent],
  );
  return rows[0];
}

export interface PgError extends Error {
  detail?: string;
}
