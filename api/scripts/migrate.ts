import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(__dirname, "../../db");

async function migrate(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename    text primary key,
        applied_at  timestamptz not null default now()
      )
    `);

    const files = (await readdir(dbDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        "select 1 from schema_migrations where filename = $1",
        [file],
      );
      if (rows.length > 0) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }

      const sql = await readFile(path.join(dbDir, file), "utf8");
      console.log(`apply ${file}`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into schema_migrations (filename) values ($1)",
          [file],
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

await migrate(connectionString);
