import type { NextFunction, Request, Response } from "express";
import { Errors } from "../errors.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every id-shaped route param eventually hits `where id = $1` against a
// uuid column. Postgres rejects a non-UUID string with a cast error that,
// uncaught, fell through to the generic 500 handler — confirmed live
// (`/vehicles/' OR '1'='1` returned 500 internal_error, not a clean 400).
// Not exploitable (the query stays parameterized either way — this isn't
// injection, just an unhandled input shape), but it's a crash on bad
// input where a clean 404/400 belongs.
export function requireUuidParams(...names: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const name of names) {
      const value = req.params[name];
      if (typeof value !== "string" || !UUID_RE.test(value)) {
        next(Errors.validation(`${name} must be a UUID`));
        return;
      }
    }
    next();
  };
}

// Express types req.params[x] as `string | string[] | undefined` (arrays
// for wildcard routes, undefined under noUncheckedIndexedAccess). Every
// current route pairs this with requireUuidParams as a guard beforehand,
// so in practice the value is already known-good by the time this runs —
// but this validates the UUID shape itself too, rather than just
// presence-as-a-string, so it stays correct even if a future route calls
// it without that guard. Defense in depth shouldn't depend on remembering
// to pair two functions correctly every time.
export function uuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw Errors.validation(`${name} must be a UUID`);
  }
  return value;
}
