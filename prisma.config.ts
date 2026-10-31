import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  engine: "classic",
  datasource: {
    // Not env("DATABASE_URL"): that throws when unset, which breaks `prisma generate`
    // (run on npm install) on a fresh clone before .env exists. Migrate still needs it.
    url: process.env.DATABASE_URL ?? "",
  },
});
