import "dotenv/config";
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://aaspai:aaspai@localhost:5432/aaspai",
  },
  strict: true,
  verbose: true,
} satisfies Config;
