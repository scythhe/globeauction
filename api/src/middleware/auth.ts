import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import * as authService from "../services/auth.ts";
import type { Actor } from "../types.ts";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor: Actor | null;
    }
  }
}

// Resolves the bearer token into an Actor on every request, authenticated
// or not — routes and services decide what to require. This alone is not
// the authorization boundary (CLAUDE.md rule 4): each service re-checks
// actor.role itself, so a route that forgets to guard still fails safely.
export function attachActor(pool: Pool) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    req.actor = await authService.resolveActor(pool, token);
    next();
  };
}
