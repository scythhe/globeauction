import { Router } from "express";
import type { Pool } from "pg";
import * as adminService from "../services/admin.ts";
import * as auctionsService from "../services/auctions.ts";
import { requireUuidParams, uuidParam } from "../middleware/validateParams.ts";
import { Errors } from "../errors.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function adminRouter(pool: Pool): Router {
  const router = Router();

  router.get("/users", async (req, res) => {
    const users = await adminService.listUnvetted(pool, req.actor);
    res.json(users);
  });

  // Not in BACKEND_SPEC.md's original §12 API surface — added because §2.1's
  // deposit process needs somewhere to record deposit_amount/received_at.
  // Worth folding into the spec's API surface on the next pass.
  router.post("/users/:id/deposit", requireUuidParams("id"), async (req, res) => {
    const { amount } = req.body ?? {};
    const user = await adminService.recordDeposit(
      pool,
      req.actor,
      uuidParam(req, "id"),
      Number(amount),
    );
    res.json(user);
  });

  router.post("/users/:id/enable-bidding", requireUuidParams("id"), async (req, res) => {
    const user = await adminService.enableBidding(pool, req.actor, uuidParam(req, "id"));
    res.json(user);
  });

  router.post("/auctions/:id/reassign-sale", requireUuidParams("id"), async (req, res) => {
    const { soldTo } = req.body ?? {};
    if (typeof soldTo !== "string" || !UUID_RE.test(soldTo)) {
      throw Errors.validation("soldTo must be a UUID");
    }
    const auction = await auctionsService.reassignSale(
      pool,
      req.actor,
      uuidParam(req, "id"),
      soldTo,
    );
    res.json(auction);
  });

  return router;
}
