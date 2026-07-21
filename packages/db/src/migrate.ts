import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Run pending migrations. Used by the dev `pnpm db:migrate` script and by
 * the install script in production. Idempotent — only applies migrations
 * that haven't been applied yet.
 *
 * The migrations folder is resolved relative to this file (so the script
 * works regardless of the CWD). In dev, the script is run via
 * `tsx ./src/migrate.ts` from packages/db/, so `./migrations` works
 * either way; in production, the script is run via the docker image
 * (which has WORKDIR=/repo/apps/web), so an absolute path is required.
 */
async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.resolve(here, "../migrations");
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(sql);
  console.log("Running migrations…");
  await migrate(db, { migrationsFolder });
  console.log("Migrations complete.");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
