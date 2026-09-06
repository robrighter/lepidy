import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const controlMigrations = await readD1Migrations("./migrations/control");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: { TEST_CONTROL_MIGRATIONS: controlMigrations },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
