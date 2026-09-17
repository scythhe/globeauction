import { Router } from "express";
import type { Pool } from "pg";
import * as authService from "../services/auth.ts";
import {
  loginRateLimiterByIp,
  loginRateLimiterByEmail,
  registerRateLimiterByIp,
} from "../middleware/rateLimit.ts";

export function authRouter(pool: Pool): Router {
  const router = Router();

  router.post("/register", registerRateLimiterByIp(), async (req, res) => {
    const { email, password, fullName, phone } = req.body ?? {};
    const user = await authService.register(pool, { email, password, fullName, phone });
    res.status(201).json(user);
  });

  // Two independent limiters: per-IP catches one machine hammering many
  // accounts, per-email catches distributed credential stuffing against
  // one account. Confirmed unthrottled (20/20 requests processed) before
  // this was added — most notably against the team account, the only one
  // with full admin power.
  router.post("/login", loginRateLimiterByIp(), loginRateLimiterByEmail(), async (req, res) => {
    const { email, password } = req.body ?? {};
    const result = await authService.login(pool, email, password);
    res.json(result);
  });

  router.get("/me", async (req, res) => {
    const user = await authService.me(pool, req.actor);
    res.json(user);
  });

  // Same bearer-token extraction as attachActor — logout needs the raw
  // token (to hash and match against the session), not req.actor, which
  // only ever carries the resolved user.
  router.post("/logout", async (req, res) => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    await authService.logout(pool, token);
    res.status(204).end();
  });

  return router;
}
