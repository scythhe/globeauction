import type { Pool } from "pg";

export interface VehiclePhoto {
  id: string;
  vehicle_id: string;
  url: string;
  sort_order: number;
  created_at: Date;
}

export async function count(pool: Pool, vehicleId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "select count(*) from vehicle_photos where vehicle_id = $1",
    [vehicleId],
  );
  return Number(rows[0]!.count);
}

// A plain count-then-insert (as requestUpload still does, to fail fast
// before handing out a presigned URL) has a race: two confirmUpload calls
// for the same vehicle can both read a count under the cap and both
// insert, exceeding MAX_PHOTOS and/or colliding on sort_order. This one
// serializes per-vehicle with a transaction-scoped advisory lock —
// concurrent callers for *different* vehicles never block each other,
// concurrent callers for the *same* vehicle queue up instead of racing.
export async function insertIfUnderCap(
  pool: Pool,
  vehicleId: string,
  url: string,
  maxPhotos: number,
): Promise<VehiclePhoto | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [vehicleId]);

    const { rows: countRows } = await client.query<{ count: string }>(
      "select count(*) from vehicle_photos where vehicle_id = $1",
      [vehicleId],
    );
    if (Number(countRows[0]!.count) >= maxPhotos) {
      await client.query("commit");
      return null;
    }

    const { rows: sortRows } = await client.query<{ next: number }>(
      "select coalesce(max(sort_order), -1) + 1 as next from vehicle_photos where vehicle_id = $1",
      [vehicleId],
    );
    const { rows } = await client.query<VehiclePhoto>(
      `insert into vehicle_photos (vehicle_id, url, sort_order)
       values ($1, $2, $3)
       returning *`,
      [vehicleId, url, sortRows[0]!.next],
    );
    await client.query("commit");
    return rows[0]!;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function listByVehicle(pool: Pool, vehicleId: string): Promise<VehiclePhoto[]> {
  const { rows } = await pool.query<VehiclePhoto>(
    "select * from vehicle_photos where vehicle_id = $1 order by sort_order asc",
    [vehicleId],
  );
  return rows;
}

export async function findById(pool: Pool, id: string): Promise<VehiclePhoto | null> {
  const { rows } = await pool.query<VehiclePhoto>("select * from vehicle_photos where id = $1", [
    id,
  ]);
  return rows[0] ?? null;
}

export async function remove(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query("delete from vehicle_photos where id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
