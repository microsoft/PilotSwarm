/**
 * setSessionModel reasoning-effort contract (source-level, in the style of
 * lossy-handoff-observability.test.js).
 *
 * A model switch WITHOUT an explicit reasoning effort must preserve a
 * compatible current effort. Runtime 1.0.112 refuses an incompatible inherited
 * effort or context tier, so management-client clears/re-targets only that
 * stale value. It must not inject a descriptor default for a compatible switch.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { assert, assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
    path.resolve(__dirname, "../../src/management-client.ts"),
    "utf8",
);
const LIFECYCLE_SRC = fs.readFileSync(path.resolve(__dirname, "../../src/orchestration/lifecycle.ts"), "utf8");
const PROXY_SRC = fs.readFileSync(path.resolve(__dirname, "../../src/session-proxy.ts"), "utf8");

describe("setSessionModel reasoning-effort contract", () => {
    it("preserves a compatible effort and writes only for explicit or stale input", () => {
        assertIncludes(
            SRC,
            'const hasExplicitEffort = !!opts && "reasoningEffort" in opts;',
            "setSessionModel must distinguish an explicit caller option",
        );
        assertIncludes(
            SRC,
            "const writesReasoningEffort = hasExplicitEffort || currentEffortIsUnsupported;",
            "a compatible omitted setting stays absent; an incompatible inherited setting is corrected",
        );
        assertIncludes(
            SRC,
            "...(writesReasoningEffort ? { reasoningEffort: nextReasoningEffort } : {})",
            "the set_model args omit a compatible setting and carry a required correction",
        );
    });

    it("never falls back to the model descriptor's default effort on switch", () => {
        // The regression pattern: `: (match.defaultReasoningEffort ?? null)`
        // as the else-branch of the effort resolution inside setSessionModel.
        const setModelBlock = SRC.slice(
            SRC.indexOf("async setSessionModel("),
            SRC.indexOf("async setSessionModel(") + 2500,
        );
        assert(
            !setModelBlock.includes("match.defaultReasoningEffort"),
            "setSessionModel must not inject the descriptor's defaultReasoningEffort when the caller omitted effort",
        );
    });

    it("clears an inherited context tier only when the target model cannot use it", () => {
        assertIncludes(
            SRC,
            "const writesContextTier = hasExplicitContextTier || currentTierIsUnsupported;",
            "a compatible tier remains preserved and a tier-less target is explicitly cleared",
        );
        assertIncludes(
            SRC,
            "...(writesContextTier ? { contextTier: nextContextTier } : {})",
            "the command carries the clear/default only when the inherited tier changed compatibility",
        );
    });

    it("persists model, effort, context tier, and switch source together", () => {
        assertIncludes(LIFECYCLE_SRC, "newContextTier,", "set_model passes the resolved context tier to persistence");
        assertIncludes(LIFECYCLE_SRC, 'String(cmdMsg.args?.source ?? "user")', "set_model passes the switch source to persistence");
        assertIncludes(PROXY_SRC, "contextTier: input.contextTier ?? null", "the activity persists context tier");
        assertIncludes(PROXY_SRC, 'modelResolutionSource: input.source ?? "model_switch"', "the activity persists source");
    });
});
