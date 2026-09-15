import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Client, Pool } from "pg";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import * as photosService from "../src/services/photos.ts";
import { getS3Client, getBucket } from "../src/storage/s3.ts";
import { ApiError } from "../src/errors.ts";
import { connect, createUser, createVehicle, reset, testPool } from "./helpers.ts";
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

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]); // not a real jpeg, just bytes

async function uploadTo(url: string, body: Buffer, contentType: string) {
  const res = await fetch(url, {
    method: "PUT",
    body: new Uint8Array(body),
    headers: { "content-type": contentType },
  });
  assert.ok(res.ok, `upload PUT failed: ${res.status} ${await res.text()}`);
}

describe("photos.requestUpload", () => {
  test("team gets a presigned URL and key for an approved vehicle", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const result = await photosService.requestUpload(pool, actorFor(team.id), vehicle.id, "image/jpeg");
    assert.match(result.uploadUrl, /^http/);
    assert.match(result.key, new RegExp(`^vehicles/${vehicle.id}/`));
  });

  test("rejects a non-team actor", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    await assert.rejects(
      () => photosService.requestUpload(pool, actorFor(buyer.id, "buyer"), vehicle.id, "image/jpeg"),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "forbidden");
        return true;
      },
    );
  });

  test("rejects an unsupported content type", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    await assert.rejects(
      () =>
        photosService.requestUpload(pool, actorFor(team.id), vehicle.id, "application/pdf"),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "unsupported_content_type");
        return true;
      },
    );
  });

  test("rejects a nonexistent vehicle", async () => {
    const team = await createUser(client, { role: "team" });
    await assert.rejects(
      () =>
        photosService.requestUpload(
          pool,
          actorFor(team.id),
          "00000000-0000-0000-0000-000000000000",
          "image/jpeg",
        ),
      (err: unknown) => {
        assert.equal((err as ApiError).status, 404);
        return true;
      },
    );
  });

  test("rejects once the 40-photo limit is reached", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    for (let i = 0; i < 40; i++) {
      await client.query(
        "insert into vehicle_photos (vehicle_id, url, sort_order) values ($1, $2, $3)",
        [vehicle.id, `http://example.com/${i}.jpg`, i],
      );
    }
    await assert.rejects(
      () => photosService.requestUpload(pool, actorFor(team.id), vehicle.id, "image/jpeg"),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "photo_limit_reached");
        return true;
      },
    );
  });
});

describe("photos.confirmUpload — real round trip against local MinIO", () => {
  test("a real presigned upload, confirmed, becomes a listed photo", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);

    const { uploadUrl, key } = await photosService.requestUpload(
      pool,
      actorFor(team.id),
      vehicle.id,
      "image/jpeg",
    );
    await uploadTo(uploadUrl, JPEG_BYTES, "image/jpeg");

    const photo = await photosService.confirmUpload(pool, actorFor(team.id), vehicle.id, key);
    assert.equal(photo.sort_order, 0);
    assert.match(photo.url, /globeauction-photos/);

    const list = await photosService.listPhotos(pool, vehicle.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, photo.id);
  });

  test("successive confirms get increasing sort_order", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);

    for (let i = 0; i < 3; i++) {
      const { uploadUrl, key } = await photosService.requestUpload(
        pool,
        actorFor(team.id),
        vehicle.id,
        "image/jpeg",
      );
      await uploadTo(uploadUrl, JPEG_BYTES, "image/jpeg");
      await photosService.confirmUpload(pool, actorFor(team.id), vehicle.id, key);
    }

    const list = await photosService.listPhotos(pool, vehicle.id);
    assert.deepEqual(list.map((p) => p.sort_order), [0, 1, 2]);
  });

  test("rejects confirming a key that was never actually uploaded", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const fakeKey = `vehicles/${vehicle.id}/never-uploaded.jpg`;
    await assert.rejects(
      () => photosService.confirmUpload(pool, actorFor(team.id), vehicle.id, fakeKey),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "upload_not_found");
        return true;
      },
    );
  });

  test("rejects a key that belongs to a different vehicle", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicleA = await createVehicle(client, team.id);
    const vehicleB = await createVehicle(client, team.id);
    const { key } = await photosService.requestUpload(
      pool,
      actorFor(team.id),
      vehicleA.id,
      "image/jpeg",
    );
    await assert.rejects(
      () => photosService.confirmUpload(pool, actorFor(team.id), vehicleB.id, key),
      (err: unknown) => {
        assert.equal((err as ApiError).status, 400);
        return true;
      },
    );
  });

  test("rejects and deletes an upload over the 10MB limit", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const { uploadUrl, key } = await photosService.requestUpload(
      pool,
      actorFor(team.id),
      vehicle.id,
      "image/jpeg",
    );
    const tooBig = Buffer.alloc(11 * 1024 * 1024, 1);
    await uploadTo(uploadUrl, tooBig, "image/jpeg");

    await assert.rejects(
      () => photosService.confirmUpload(pool, actorFor(team.id), vehicle.id, key),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "file_too_large");
        return true;
      },
    );

    // and the oversized object must not be left sitting in storage
    await assert.rejects(() =>
      getS3Client().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key })),
    );
  });
});

describe("photos.deletePhoto", () => {
  test("removes the DB row and the underlying storage object", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicle = await createVehicle(client, team.id);
    const { uploadUrl, key } = await photosService.requestUpload(
      pool,
      actorFor(team.id),
      vehicle.id,
      "image/jpeg",
    );
    await uploadTo(uploadUrl, JPEG_BYTES, "image/jpeg");
    const photo = await photosService.confirmUpload(pool, actorFor(team.id), vehicle.id, key);

    await photosService.deletePhoto(pool, actorFor(team.id), vehicle.id, photo.id);

    const list = await photosService.listPhotos(pool, vehicle.id);
    assert.equal(list.length, 0);
    await assert.rejects(() =>
      getS3Client().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key })),
    );
  });

  test("rejects a non-team actor", async () => {
    const team = await createUser(client, { role: "team" });
    const buyer = await createUser(client, { role: "buyer" });
    const vehicle = await createVehicle(client, team.id);
    await client.query(
      "insert into vehicle_photos (vehicle_id, url, sort_order) values ($1, 'http://x/y.jpg', 0) returning id",
      [vehicle.id],
    );
    const { rows } = await client.query("select id from vehicle_photos where vehicle_id = $1", [
      vehicle.id,
    ]);
    await assert.rejects(
      () =>
        photosService.deletePhoto(pool, actorFor(buyer.id, "buyer"), vehicle.id, rows[0].id),
      (err: unknown) => {
        assert.equal((err as ApiError).code, "forbidden");
        return true;
      },
    );
  });

  test("rejects a photo that belongs to a different vehicle", async () => {
    const team = await createUser(client, { role: "team" });
    const vehicleA = await createVehicle(client, team.id);
    const vehicleB = await createVehicle(client, team.id);
    const { rows } = await client.query(
      "insert into vehicle_photos (vehicle_id, url, sort_order) values ($1, 'http://x/y.jpg', 0) returning id",
      [vehicleA.id],
    );
    await assert.rejects(
      () => photosService.deletePhoto(pool, actorFor(team.id), vehicleB.id, rows[0].id),
      (err: unknown) => {
        assert.equal((err as ApiError).status, 404);
        return true;
      },
    );
  });
});
