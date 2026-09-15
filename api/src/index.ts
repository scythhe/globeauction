import { createApp } from "./app.ts";
import { getPool } from "./db/pool.ts";
import { startJobLoop } from "./jobs/runner.ts";

const pool = getPool();
const app = createApp(pool);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`globeauction-api listening on :${port}`);
});

// §8: background jobs run in this same process, every 30 seconds.
startJobLoop(pool, 30_000);
