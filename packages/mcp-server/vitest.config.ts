import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      CMS_ENDPOINT: "http://localhost:3000",
    },
  },
});
