import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    // Inject required env vars for integration tests
    env: {
      POSTGRES_PASSWORD: "cms_dev_pass",
      MINIO_ROOT_PASSWORD: "minio_dev_pass",
      CMS_CI_TOKEN: "ci-secret-token",
      CMS_CLIENT_TOKEN: "client-secret-token",
    },
  },
});
