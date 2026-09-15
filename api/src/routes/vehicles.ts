import { Router } from "express";
import type { Pool } from "pg";
import * as vehiclesService from "../services/vehicles.ts";
import * as photosService from "../services/photos.ts";
import { requireUuidParams, uuidParam } from "../middleware/validateParams.ts";
import { Errors } from "../errors.ts";

export function vehiclesRouter(pool: Pool): Router {
  const router = Router();

  // Phase 1 only: team creates a vehicle directly in 'approved'. See
  // BACKEND_SPEC.md §3 — there is no submit/approve flow to wire up yet.
  router.post("/", async (req, res) => {
    const vehicle = await vehiclesService.create(pool, req.actor, req.body ?? {});
    res.status(201).json(vehicle);
  });

  router.get("/:id", requireUuidParams("id"), async (req, res) => {
    const vehicle = await vehiclesService.getById(pool, uuidParam(req, "id"));
    res.json(vehicle);
  });

  // §11: presigned-upload flow. team-only in phase 1 (there's no dealer
  // submission flow to hang this off yet).
  router.post("/:id/photos", requireUuidParams("id"), async (req, res) => {
    const { contentType } = req.body ?? {};
    if (typeof contentType !== "string") {
      throw Errors.validation("contentType is required");
    }
    const result = await photosService.requestUpload(pool, req.actor, uuidParam(req, "id"), contentType);
    res.status(201).json(result);
  });

  // Not in BACKEND_SPEC.md's §12 API surface by exact name — §11's prose
  // describes this step ("client calls back to confirm; API inserts the
  // vehicle_photos row") without naming the route. Worth folding into the
  // spec's API surface table on the next pass, same as the deposit and
  // reassign-sale endpoints before it.
  router.post("/:id/photos/confirm", requireUuidParams("id"), async (req, res) => {
    const { key } = req.body ?? {};
    if (typeof key !== "string") {
      throw Errors.validation("key is required");
    }
    const photo = await photosService.confirmUpload(pool, req.actor, uuidParam(req, "id"), key);
    res.status(201).json(photo);
  });

  // Also not explicitly in §12 — needed for the frontend to display photos.
  router.get("/:id/photos", requireUuidParams("id"), async (req, res) => {
    const photos = await photosService.listPhotos(pool, uuidParam(req, "id"));
    res.json(photos);
  });

  router.delete("/:id/photos/:photoId", requireUuidParams("id", "photoId"), async (req, res) => {
    const result = await photosService.deletePhoto(
      pool,
      req.actor,
      uuidParam(req, "id"),
      uuidParam(req, "photoId"),
    );
    res.json(result);
  });

  return router;
}
