import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@rootline/contracts": new URL("../contracts/src/index.ts", import.meta.url).pathname,
    },
  },
});
