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
const DEV_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

export function createApp(pool: Pool) {
  const app = express();

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", DEV_ORIGIN);
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
