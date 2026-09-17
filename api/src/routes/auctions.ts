import { Router } from "express";
import type { Pool } from "pg";
import * as auctionsService from "../services/auctions.ts";
import * as biddingService from "../services/bidding.ts";
import type { AuctionStatus } from "../repositories/auctions.ts";
import { bidRateLimiter } from "../middleware/rateLimit.ts";
import { requireUuidParams, uuidParam } from "../middleware/validateParams.ts";

export function auctionsRouter(pool: Pool): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const auction = await auctionsService.create(pool, req.actor, req.body ?? {});
    res.status(201).json(auction);
  });

  router.get("/", async (req, res) => {
    const status = req.query.status as string | undefined;
    const make = req.query.make as string | undefined;
    const year = req.query.year ? Number(req.query.year) : undefined;

    const statusFilter: AuctionStatus[] | undefined =
      status === "live" ? ["live"] : status === "upcoming" ? ["scheduled"] : undefined;

    const auctions = await auctionsService.list(pool, req.actor, {
      status: statusFilter,
      make,
      year,
    });
    res.json(auctions);
  });

  router.get("/:id", requireUuidParams("id"), async (req, res) => {
    const auction = await auctionsService.getById(pool, req.actor, uuidParam(req, "id"));
    res.json(auction);
  });

  router.get("/:id/bids", requireUuidParams("id"), async (req, res) => {
    const bids = await auctionsService.listBids(pool, req.actor, uuidParam(req, "id"));
    res.json(bids);
  });

  router.post("/:id/cancel", requireUuidParams("id"), async (req, res) => {
    const auction = await auctionsService.cancel(pool, req.actor, uuidParam(req, "id"));
    res.json(auction);
  });

  // §12: rate limit bidding per user — not for load, to stop a script
  // walking an opponent's ceiling up with repeated minimum bids.
  router.post("/:id/bids", requireUuidParams("id"), bidRateLimiter(), async (req, res) => {
    const { max_amount } = req.body ?? {};
    const bid = await biddingService.placeBid(
      pool,
      req.actor,
      uuidParam(req, "id"),
      max_amount,
      {
        ipAddress: req.ip ?? null,
        userAgent: req.header("user-agent") ?? null,
      },
    );
    res.status(201).json(bid);
  });

  // Same per-user rate limit as ordinary bidding — no reason this path
  // should be exempt from the same script-abuse protection.
  router.post("/:id/buy-now", requireUuidParams("id"), bidRateLimiter(), async (req, res) => {
    const auction = await auctionsService.buyNow(pool, req.actor, uuidParam(req, "id"), {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
    res.json(auction);
  });

  router.post("/:id/accept", requireUuidParams("id"), async (req, res) => {
    const auction = await auctionsService.acceptAsIs(pool, req.actor, uuidParam(req, "id"));
    res.json(auction);
  });

  router.post("/:id/decline", requireUuidParams("id"), async (req, res) => {
    const auction = await auctionsService.decline(pool, req.actor, uuidParam(req, "id"));
    res.json(auction);
  });

  return router;
}
