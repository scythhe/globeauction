import type { UserRole } from "./repositories/users.ts";

// The authenticated caller, as resolved by auth middleware from a session
// token. Passed explicitly into every service function so authorization is
// checked in the service layer itself (CLAUDE.md rule 4) — a route that
// forgets its middleware, or passes null, still gets rejected here, not
// just left to the route layer to remember.
export interface Actor {
  id: string;
  role: UserRole;
  organizationId: string | null;
  canBid: boolean;
  isActive: boolean;
}
