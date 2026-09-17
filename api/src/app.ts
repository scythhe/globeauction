import express, { type ErrorRequestHandler } from "express";
import type { Pool } from "pg";
import { attachActor } from "./middleware/auth.ts";
import { authRouter } from "./routes/auth.ts";
import { vehiclesRouter } from "./routes/vehicles.ts";
import { adminRouter } from "./routes/admin.ts";
import { auctionsRouter } from "./routes/auctions.ts";
import { ApiError } from "./errors.ts";

// Hand-rolled rather than pulling in the `cors` package — the frontend only
// ever sends a Bearer token header, never cookies, so there's no credentials
// mode to worry about and this is the entire surface we need.
//
// localhost and 127.0.0.1 both accepted for the default dev port: they're
// the same machine either way, and a request from one that got silently
// CORS-blocked because a browser happened to be pointed at the other looks
// exactly like "the whole app is broken" — every fetch fails with no useful
// error, not just one feature. WEB_ORIGIN overrides this entirely for a
// real deployment, where only one real origin should ever be allowed.
const DEFAULT_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const ALLOWED_ORIGINS = process.env.WEB_ORIGIN
  ? [process.env.WEB_ORIGIN]
  : DEFAULT_DEV_ORIGINS;

export function createApp(pool: Pool) {
  const app = express();

  // Without this, req.ip is the connecting socket's address — behind any
  // reverse proxy (Cloudflare, nginx, a load balancer) that's the proxy's
  // own IP for every request, collapsing every per-IP rate limiter
  // (login, registration, bidding) into one shared bucket across all
  // users. TRUST_PROXY is the number of trusted proxy hops in front of
  // this process (set to the real count in prod — "1" for a single
  // reverse proxy); unset/0 in local dev, where there is no proxy and
  // trusting one would let a client spoof X-Forwarded-For to fake
  // whatever IP it wants and dodge rate limiting entirely.
  const trustProxyHops = Number(process.env.TRUST_PROXY ?? 0);
  if (trustProxyHops > 0) {
    app.set("trust proxy", trustProxyHops);
  }

  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json());
  app.use(attachActor(pool));

  app.use("/api/auth", authRouter(pool));
  app.use("/api/vehicles", vehiclesRouter(pool));
  app.use("/api/admin", adminRouter(pool));
  app.use("/api/auctions", auctionsRouter(pool));

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ApiError) {
      if (err.code === "rate_limited" && typeof err.extra.retryAfterSeconds === "number") {
        res.header("Retry-After", String(err.extra.retryAfterSeconds));
      }
      res.status(err.status).json(err.toJSON());
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  };
  app.use(errorHandler);

  return app;
}
