// Creates a 'team' account. There is no API endpoint for this on purpose —
// self-registration only ever creates 'buyer' accounts (src/services/auth.ts).
// Run: DATABASE_URL=... node scripts/seed-team.ts <email> <password> "<full name>"

import { Pool } from "pg";
import { hashPassword } from "../src/auth/passwords.ts";

const [, , email, password, fullName] = process.argv;

if (!email || !password || !fullName) {
  console.error('Usage: node scripts/seed-team.ts <email> <password> "<full name>"');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const passwordHash = await hashPassword(password);

const { rows } = await pool.query(
  `insert into users (email, password_hash, role, full_name)
   values ($1, $2, 'team', $3)
   returning id, email, role`,
  [email, passwordHash, fullName],
);

console.log("created team user:", rows[0]);
await pool.end();
