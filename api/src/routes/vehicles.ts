import { Router } from "express";
import type { Pool } from "pg";
import * as vehiclesService from "../services/vehicles.ts";
import { requireUuidParams, uuidParam } from "../middleware/validateParams.ts";

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

  return router;
}
