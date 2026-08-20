import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function migrate(pool, directory = join(process.cwd(), "migrations")) {
  if (!pool) return;
  const setup = await pool.connect();
  try {
    await setup.query("BEGIN");
    await setup.query("SELECT pg_advisory_xact_lock(hashtext('nimbus-schema-migrations'))");
    await setup.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK");
    throw error;
  } finally {
    setup.release();
  }
  const files = (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('nimbus-schema-migrations'))");
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
      if (!applied.rowCount) {
        await client.query(await readFile(join(directory, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
