import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The integration tests share one database and wipe tables between tests, so files must not overlap.
    fileParallelism: false,
    // The first suite to touch a brand-new database applies every migration in its setup hook. On a cold disk or a
    // small CI runner that can take longer than the 10 s default.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
