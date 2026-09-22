import { createApp } from "./app.ts";
import { getPool } from "./db/pool.ts";
import { startJobLoop } from "./jobs/runner.ts";

const pool = getPool();
const app = createApp(pool);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`globeauction-api listening on :${port}`);
});

// §8 originally specified 30 seconds — fine for a normal close, since the
// last bid already pushed the deadline out. Not fine for the db/012 bonus
// round, which fires on silence: at 30s, a still-live auction can sit
// showing "ended" for up to half a minute before the bonus round revives
// it, which reads as broken rather than dramatic. 1 second instead — cheap
// at phase 1's volume (one lot a week) and keeps the bonus feeling instant.
startJobLoop(pool, 1_000);
