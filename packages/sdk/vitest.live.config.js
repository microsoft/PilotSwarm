// Live suites (test/live): they call paid services and need their own configuration, so no default suite runs them.
// The default suites' settings with the live suites' include only (mergeConfig would add test/local to it).
import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

export default defineConfig({ test: { ...base.test, include: ["test/live/**/*.test.js"] } });
