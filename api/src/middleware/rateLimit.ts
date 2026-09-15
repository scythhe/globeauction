import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../errors.ts";

// Hand-rolled, in-memory, single-process. Fine for phase 1 (one API
// process, one server) — resets on restart and doesn't share state across
// instances, so revisit with a shared store (Redis, or a DB table) before
// ever running more than one API process behind a load balancer.
interface Bucket {
  count: number;
  resetAt: number;
}

export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  keyFn: (req: Request) => string;
}) {
  const buckets = new Map<string, Bucket>();

  // Lazy expiry keeps lookups O(1); this sweep just keeps the map from
  // growing unbounded between requests over a long-running process.
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, opts.windowMs).unref();

  return (req: Request, _res: Response, next: NextFunction) => {
    const key = opts.keyFn(req);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > opts.max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      next(new ApiError(429, "rate_limited", { retryAfterSeconds }));
      return;
    }

    next();
  };
}

// §12 security notes: "Rate limit POST /auctions/:id/bids per user. Not for
// load — to stop a script walking an opponent's ceiling up with repeated
// minimum bids." Keyed by bidder id (set by attachActor before this runs),
// falling back to IP for the (already-401'd) unauthenticated case.
export function bidRateLimiter() {
  return createRateLimiter({
    windowMs: 10_000,
    max: 10,
    keyFn: (req) => req.actor?.id ?? req.ip ?? "unknown",
  });
}

// Login: two independent limits. Per-IP stops one machine from hammering
// many accounts.
export function loginRateLimiterByIp() {
  return createRateLimiter({
    windowMs: 15 * 60_000,
    max: 30,
    keyFn: (req) => req.ip ?? "unknown",
  });
}

// The second limiter was originally keyed on email alone. That's a real
// vulnerability, confirmed live in a second pentest pass: it counts EVERY
// attempt against that email — successful or not, valid password or not —
// so anyone who just knows a victim's email (the team account's address is
// presumably public) can lock that account out of logging in for 15
// minutes using nothing but 8 garbage POSTs. No credentials needed. For a
// system where the team account is the only one that can enable bidding or
// manage a hard Friday deadline, that's a real, timed denial-of-service.
//
// Keying on ip+email instead fixes it: an attacker grinding one account's
// password from their own machine still gets throttled after 8 tries, but
// the real owner logging in from their own IP has an independent bucket —
// the attacker's failed attempts never touch it. Trade-off, stated
// honestly: a distributed attacker (many source IPs) could still grind one
// account slower, one bucket per IP. That's the standard, accepted
// trade-off for this kind of limiter — the alternative is the lockout
// vulnerability this replaces, which is worse.
export function loginRateLimiterByEmail() {
  return createRateLimiter({
    windowMs: 15 * 60_000,
    max: 8,
    keyFn: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      const emailKey = typeof email === "string" ? email.toLowerCase() : "no-email";
      return `${req.ip ?? "unknown"}:${emailKey}`;
    },
  });
}

export function registerRateLimiterByIp() {
  return createRateLimiter({
    windowMs: 60 * 60_000,
    max: 10,
    keyFn: (req) => req.ip ?? "unknown",
  });
}
