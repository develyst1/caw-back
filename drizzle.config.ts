import { defineConfig } from "drizzle-kit";

// Every table lives in the Postgres schema `caw` (SPEC-A-008 § Configuration); nothing is written to `public`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  schemaFilter: ["caw"],
});
