import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Browser-backed tests are slower than the default 5s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
