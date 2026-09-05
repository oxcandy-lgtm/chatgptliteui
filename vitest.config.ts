import { defineConfig } from "vitest/config";

/**
 * Test build identity: deterministic fixtures so tests never depend on the
 * developer's git state. The REAL bundle gets the real identity from
 * scripts/build-identity.mjs at `npm run build`.
 */
const TEST_BUILD_DEFINES = {
  __CGL_BUILD_ID__: JSON.stringify("0.1.0+testfixture"),
  __CGL_SOURCE_HEAD__: JSON.stringify("testfix"),
  __CGL_DIRTY_AT_BUILD__: "false",
};

export default defineConfig({
  define: TEST_BUILD_DEFINES,
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
