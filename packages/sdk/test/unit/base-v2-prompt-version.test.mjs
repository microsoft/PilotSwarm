// The base V2 prompt has no frontmatter, so its SemVer lives beside it in
// base-agent-policy.ts with the sha256 of its bytes. Changing the prompt
// without bumping BASE_V2_PROMPT_VERSION and updating the hash fails here.
//
// Run: node --test test/unit/base-v2-prompt-version.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASE_V2_PROMPT_VERSION, BASE_V2_PROMPT_SHA256 } from "../../dist/base-agent-policy.js";

test("the base V2 prompt's bytes match its recorded version", () => {
    // The recorded hash is of LF text; a Windows checkout may use CRLF.
    const text = readFileSync(fileURLToPath(new URL("../../plugins/system/prompts/base-v2.md", import.meta.url)), "utf8").replace(/\r\n/g, "\n").trim();
    const sha = createHash("sha256").update(text).digest("hex");
    assert.equal(sha, BASE_V2_PROMPT_SHA256,
        `base-v2.md changed: bump BASE_V2_PROMPT_VERSION (now ${BASE_V2_PROMPT_VERSION}) and set BASE_V2_PROMPT_SHA256 to ${sha}`);
    assert.match(BASE_V2_PROMPT_VERSION, /^\d+\.\d+\.\d+$/);
});
