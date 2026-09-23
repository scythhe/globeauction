import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client, Pool } from "pg";
import * as vehiclesService from "../src/services/vehicles.ts";
import { ApiError } from "../src/errors.ts";
import { connect, createAuction, createUser, reset, testPool } from "./helpers.ts";
import type { Actor } from "../src/types.ts";

let client: Client;
let pool: Pool;

before(async () => {
  client = await connect();
  pool = testPool();
});

after(async () => {
  await client.end();
  await pool.end();
});

beforeEach(async () => {
  await reset(client);
});

function actorFor(id: string, role: "team" | "buyer" | "dealer" = "team"): Actor {
  return { id, role, organizationId: null, canBid: false, isActive: true };
}

describe("vehicles.create — happy path (§3: phase 1 skips draft/pending, goes straight to approved)", () => {
  test("creates a vehicle owned by the team member who created it, already approved", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await vehiclesService.create(pool, actorFor(team.id), {
      make: "Toyota",
      model: "Camry",
      year: 2020,
    });
    assert.equal(vehicle.status, "approved");
    assert.equal(vehicle.owner_id, team.id);
    assert.equal(vehicle.make, "Toyota");
  });

  test("requires authentication", async () => {
    await assert.rejects(
      () => vehiclesService.create(pool, null, { make: "Toyota", model: "Camry", year: 2020 }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, "unauthenticated");
        return true;
      },
    );
  });

  test("requires make, model, and year", async () => {
    const team = await createUser(client, { role: "team" });
    await assert.rejects(() =>
      vehiclesService.create(pool, actorFor(team.id), { make: "", model: "Camry", year: 2020 }),
    );
  });
});

describe("vehicles.getById", () => {
  test("returns the vehicle when it exists", async () => {
    const team = await createUser(client, { role: "team" });
    const created = await vehiclesService.create(pool, actorFor(team.id), {
      make: "Honda",
      model: "Civic",
      year: 2018,
    });
    const fetched = await vehiclesService.getById(pool, created.id);
    assert.equal(fetched.id, created.id);
  });

  test("throws not_found for a nonexistent (but well-formed) id", async () => {
    await assert.rejects(
      () => vehiclesService.getById(pool, "00000000-0000-0000-0000-000000000000"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

// Feeds the team panel's auction-creation picker: only a vehicle
// auctions.create() would actually accept a new auction for — approved,
// and not already carrying an open one — should show up.
describe("vehicles.listAvailableForAuction", () => {
  test("includes an approved vehicle with no auction at all", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await vehiclesService.create(pool, actorFor(team.id), {
      make: "Mazda",
      model: "6",
      year: 2019,
    });
    const list = await vehiclesService.listAvailableForAuction(pool, actorFor(team.id));
    assert.ok(list.some((v) => v.id === vehicle.id));
  });

  test("excludes a vehicle that already has a live auction", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await vehiclesService.create(pool, actorFor(team.id), {
      make: "Mazda",
      model: "6",
      year: 2019,
    });
    await createAuction(client, vehicle.id, team.id);

    const list = await vehiclesService.listAvailableForAuction(pool, actorFor(team.id));
    assert.ok(!list.some((v) => v.id === vehicle.id));
  });

  test("re-includes a vehicle once its auction is no longer open (e.g. cancelled)", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await vehiclesService.create(pool, actorFor(team.id), {
      make: "Mazda",
      model: "6",
      year: 2019,
    });
    await createAuction(client, vehicle.id, team.id);
    await client.query("update auctions set status = 'cancelled' where vehicle_id = $1", [
      vehicle.id,
    ]);

    const list = await vehiclesService.listAvailableForAuction(pool, actorFor(team.id));
    assert.ok(list.some((v) => v.id === vehicle.id));
  });

  test("rejects a non-team actor", async () => {
    const buyer = await createUser(client, { role: "buyer" });
    await assert.rejects(
      () => vehiclesService.listAvailableForAuction(pool, actorFor(buyer.id, "buyer")),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, "forbidden");
        return true;
      },
    );
  });
});
