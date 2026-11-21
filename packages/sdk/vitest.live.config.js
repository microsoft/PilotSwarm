// Live suites (test/live): they call paid services and need their own configuration, so no default suite runs them.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(base, defineConfig({ test: { include: ["test/live/**/*.test.js"] } }));
