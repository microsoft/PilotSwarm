/**
 * Request capture for the differential test C1 in
 * docs/proposals/session-workspaces.md.
 *
 * One session with a fixed id, no workspace and the default agent sends one
 * prompt to the scripted model. The test keeps the first model request of
 * that session. It runs once per native-task mode.
 *
 * Alone, it checks that the capture works. With PS_CAPTURE_DIR set, it also
 * writes the raw request and its normalized text there.
 * scripts/differential-capture.mjs runs it on this tree and on the
 * merge-base, then diffs the normalized text.
 *
 * Run: npx vitest run test/local/request-capture.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert } from "../helpers/assertions.js";
import { normalizeRequest, renderNormalized } from "../helpers/request-normalizer.mjs";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";

const TIMEOUT = 180_000;
const SESSION_ID = "00000000-0000-4000-8000-0000000000c1";
const OWNER = { provider: "test", subject: "capture-owner" };
const PROMPT = "request capture prompt";
const OUT = process.env.PS_CAPTURE_DIR;
const MODES = (process.env.PS_CAPTURE_MODES || "off,sync").split(",").map((m) => m.trim()).filter(Boolean);

const getEnv = useSuiteEnv(import.meta.url);

describe("request capture", () => {
    for (const mode of MODES) {
        it(`captures the first session request (native tasks ${mode})`, { timeout: TIMEOUT }, async () => {
            const env = getEnv();
            if (mode === "sync") await setClusterFeature(env, "copilot.native_tasks", true);

            await withScriptedModel(env, { worker: { nativeSubagents: mode } }, async ({ client, model, qualifiedModel }) => {
                const session = await client.createSession({ sessionId: SESSION_ID, model: qualifiedModel, owner: OWNER });
                await session.sendAndWait(PROMPT, TIMEOUT);

                const first = model.sessionRequests(PROMPT)[0];
                assert(first, "the session sent at least one model request");
                const names = first.body.tools.map((t) => t?.function?.name);
                // The CLI's native task tool is declared only in sync mode, so
                // this proves the run really used the requested mode.
                assert(names.includes("task") === (mode === "sync"),
                    `native mode ${mode}: expected task tool ${mode === "sync" ? "present" : "absent"}, got [${names.join(", ")}]`);

                const normalized = normalizeRequest(first.body, {
                    baseDir: env.baseDir,
                    sessionStateDir: env.sessionStateDir,
                    cwd: process.cwd(),
                    tmpdir: os.tmpdir(),
                    home: os.homedir(),
                    runId: env.runId,
                });
                assert(normalized.system.length > 0, "the request has a system message");

                if (OUT) {
                    fs.mkdirSync(OUT, { recursive: true });
                    fs.writeFileSync(path.join(OUT, `request-${mode}.raw.json`), JSON.stringify(first.body, null, 2));
                    fs.writeFileSync(path.join(OUT, `request-${mode}.txt`), renderNormalized(normalized));
                }
            });
        });
    }
});
