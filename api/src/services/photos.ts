import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as photosRepo from "../repositories/vehiclePhotos.ts";
import * as vehiclesRepo from "../repositories/vehicles.ts";
import { getS3Client, getBucket, publicUrlFor, keyFromPublicUrl } from "../storage/s3.ts";
import { ApiError, Errors } from "../errors.ts";
import type { Actor } from "../types.ts";

// §11: 40 photos per vehicle, 10 MB each, jpeg/png/webp only. "Validate
// the content type when issuing the presigned URL, not after" — the
// allowed-type check happens before a URL is ever handed out, and the
// presigned PUT itself is signed with that Content-Type, so an upload
// with a different header won't match the signature and will be rejected
// by the storage service itself, not just trusted client-side.
const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_PHOTOS = 40;
const MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 5 * 60;

function requireTeam(actor: Actor | null) {
  if (!actor) throw Errors.unauthenticated();
  if (actor.role !== "team") throw Errors.forbidden();
}

export async function requestUpload(
  pool: Pool,
  actor: Actor | null,
  vehicleId: string,
  contentType: string,
) {
  requireTeam(actor);

  const vehicle = await vehiclesRepo.findById(pool, vehicleId);
  if (!vehicle) throw Errors.notFound("vehicle");

  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    throw new ApiError(400, "unsupported_content_type", {
      allowed: Object.keys(ALLOWED_TYPES),
    });
  }

  const existing = await photosRepo.count(pool, vehicleId);
  if (existing >= MAX_PHOTOS) {
    throw new ApiError(400, "photo_limit_reached", { max: MAX_PHOTOS });
  }

  const key = `vehicles/${vehicleId}/${randomUUID()}.${ext}`;
  const uploadUrl = await getSignedUrl(
    getS3Client(),
    new PutObjectCommand({ Bucket: getBucket(), Key: key, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );

  return { uploadUrl, key, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
}

export async function confirmUpload(
  pool: Pool,
  actor: Actor | null,
  vehicleId: string,
  key: string,
) {
  requireTeam(actor);

  // The key must actually belong to this vehicle — otherwise a team
  // member could confirm an arbitrary key (including one from a
  // different vehicle's upload) onto this one.
  if (!key.startsWith(`vehicles/${vehicleId}/`)) {
    throw Errors.validation("key does not belong to this vehicle");
  }

  const s3 = getS3Client();
  const bucket = getBucket();

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    throw new ApiError(400, "upload_not_found", {
      reason: "no object at that key — did the PUT to uploadUrl actually complete?",
    });
  }

  if ((head.ContentLength ?? 0) > MAX_BYTES) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    throw new ApiError(400, "file_too_large", { maxBytes: MAX_BYTES });
  }
  if (!head.ContentType || !(head.ContentType in ALLOWED_TYPES)) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    throw new ApiError(400, "unsupported_content_type", {
      allowed: Object.keys(ALLOWED_TYPES),
    });
  }

  const photo = await photosRepo.insertIfUnderCap(pool, vehicleId, publicUrlFor(key), MAX_PHOTOS);
  if (!photo) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    throw new ApiError(400, "photo_limit_reached", { max: MAX_PHOTOS });
  }
  return photo;
}

export async function listPhotos(pool: Pool, vehicleId: string) {
  return photosRepo.listByVehicle(pool, vehicleId);
}

export async function setPrimary(
  pool: Pool,
  actor: Actor | null,
  vehicleId: string,
  photoId: string,
) {
  requireTeam(actor);

  const photo = await photosRepo.setPrimary(pool, vehicleId, photoId);
  if (!photo) throw Errors.notFound("photo");
  return photo;
}

export async function deletePhoto(
  pool: Pool,
  actor: Actor | null,
  vehicleId: string,
  photoId: string,
) {
  requireTeam(actor);

  const photo = await photosRepo.findById(pool, photoId);
  if (!photo || photo.vehicle_id !== vehicleId) {
    throw Errors.notFound("photo");
  }

  const removed = await photosRepo.remove(pool, photoId);
  if (!removed) throw Errors.notFound("photo");

  // Best-effort: the DB row is the source of truth for what's attached to
  // the vehicle (already removed above), so a storage-side failure here
  // shouldn't fail the whole delete — it just leaves an orphaned object,
  // which is a cleanup nit, not a correctness problem.
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: getBucket(), Key: keyFromPublicUrl(photo.url) }),
    );
  } catch (err) {
    console.error(`photos: failed to delete storage object for photo ${photoId}`, err);
  }

  return { id: photoId };
}
