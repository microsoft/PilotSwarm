/**
 * Binding-fingerprint capture for the differential test C3 in
 * docs/proposals/session-workspaces.md.
 *
 * Builds a real SessionManager from dist/ with the Copilot transport stubbed
 * (the session-agent-binding-lifecycle unit pattern), opens one session with
 * a config that has no workspace, and reports the binding fingerprint that
 * decides whether a warm session must be recreated. It also reports the tool
 * names the SDK config declared, so a diff shows what changed.
 *
 * Usage: node test/helpers/fingerprint-capture.mjs <out.json>
 * Needs `npm run build` first. scripts/differential-capture.mjs runs it on
 * this tree and on the merge-base.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../dist/session-manager.js";
import { FeatureFlagCache } from "../../dist/feature-flag-cache.js";
import { FEATURE_FLAGS } from "../../dist/feature-flags.js";

const SESSION_ID = "00000000-0000-4000-8000-0000000000c3";

async function nativePolicy(enabled) {
    const featureKey = "copilot.native_tasks";
    const cache = new FeatureFlagCache({
        revisions: async () => [{ featureKey, revision: "1" }],
        snapshot: async () => ({
            definitions: [{ featureKey, ...FEATURE_FLAGS[featureKey], revision: "1" }],
            settings: [{ featureKey, scope: "cluster", userId: null, enabled, allowUserOverride: false, revision: "1" }],
        }),
    });
    await cache.pollRevisionsAndRefresh();
    return cache;
}

/** Capture the fingerprint for one native-task mode ("off" or "sync"). */
export async function captureFingerprint(mode) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-fingerprint-"));
    const calls = [];
    const cache = await nativePolicy(mode === "sync");
    const manager = new SessionManager(undefined, null, { nativeSubagents: mode }, home);
    manager.setFeatureFlagCache(cache);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const open = (kind, config) => {
        calls.push({ kind, config });
        fs.mkdirSync(path.join(home, config.sessionId), { recursive: true });
        return { disconnect: async () => {} };
    };
    manager.ensureClient = async () => ({
        createSession: async (config) => open("create", config),
        resumeSession: async (_id, config) => open("resume", config),
        deleteSession: async () => {},
    });
    try {
        await manager.getOrCreate(SESSION_ID, {}, { turnIndex: 0 });
        const fingerprint = manager.sessionBindingFingerprints.get(SESSION_ID);
        if (!fingerprint) throw new Error("no binding fingerprint was recorded");
        const sdk = calls.at(-1)?.config;
        return {
            mode,
            fingerprint,
            sdkCalls: calls.map((c) => c.kind),
            tools: (sdk?.tools ?? []).map((t) => t.name),
            excludedTools: sdk?.excludedTools ?? null,
        };
    } finally {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        await cache.stop?.();
        fs.rmSync(home, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const out = process.argv[2];
    const result = [];
    for (const mode of ["off", "sync"]) result.push(await captureFingerprint(mode));
    const text = JSON.stringify(result, null, 2) + "\n";
    if (out) fs.writeFileSync(out, text);
    else process.stdout.write(text);
}
