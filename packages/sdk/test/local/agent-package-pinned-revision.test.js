/**
 * Exact earlier package revisions for pinned sessions (workflow package
 * pins, R18; design 03 package agents, test plan T070), against a real
 * worker and registry with no model turn. INACTIVE: only a workflow agent
 * state binds a child this way, and only test hosts start runs that do.
 *
 * Proves that after a package is republished, a worker asked for the exact
 * earlier revision (`<packageId>@<sha256>`) installs it beside the active
 * version and serves it only to that binding: its own prompt, its own
 * revision's skill composed in, and its own tool handlers, while the
 * default copy, discovery, the flat tool registry and the shared skill
 * catalog keep the active version. The revision survives later refreshes,
 * and a disabled package serves no revision. An unknown revision is not
 * served.
 *
 * Run: npx vitest run test/local/agent-package-pinned-revision.test.js
 */

import { describe, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";
import { pinnedAgentPackageId, parsePinnedAgentPackageId } from "../../src/agent-package-pins.ts";
import { pickAgentCopyByPackageIdForOwner, pickAgentCopyForOwner } from "../../src/session-manager.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "pkg-pinned-owner" };
const AGENT = "pinned-triager";
const TOOL = "pinned_echo";

/** One version of the fixture package: its prompt line, its skill's line and its tool's answer all name the version. */
function writePackageVersion(dir, version) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills", "triage-notes"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "pinned-kit", version, description: "pinned revision fixture" }));
    fs.writeFileSync(path.join(dir, "agents", `${AGENT}.agent.md`), [
        "---",
        `name: ${AGENT}`,
        "description: Fixture agent whose every version is distinguishable",
        "schemaVersion: 1",
        `version: ${version}`,
        "tools:",
        `  - ${TOOL}`,
        "skills:",
        "  - triage-notes",
        "---",
        "",
        `You are the pinned triager, version ${version}.`,
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "skills", "triage-notes", "SKILL.md"), [
        "---", "name: triage-notes", "description: Triage notes of one version", "---",
        "", `Triage notes of version ${version}.`,
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "tools", "worker-module.js"), [
        "export default {",
        "    createTools: () => [{",
        `        name: ${JSON.stringify(TOOL)},`,
        "        description: \"Says which version answered\",",
        "        parameters: { type: \"object\", properties: {} },",
        `        handler: async () => ({ version: ${JSON.stringify(version)} }),`,
        "    }],",
        "};",
        "",
    ].join("\n"));
    return dir;
}

describe("exact earlier package revisions for pinned sessions (workflow package pins, inactive)", () => {
    it("a republished package's earlier revision is served only to its pinned binding, with its own prompt, skill and tools", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const artifactStore = new FilesystemArtifactStore(path.join(path.dirname(env.sessionStateDir), "artifacts"));
        const ctx = { catalog, artifactStore };
        const cacheDir = path.join(env.baseDir, "agent-packages-cache");
        const fixtures = path.join(env.baseDir, "pinned-fixtures");
        const modelProvidersPath = path.join(env.baseDir, "model-providers.pinned-revision.json");
        try {
            // No model turn runs here; an isolated fake provider keeps the worker independent of ambient credentials.
            fs.writeFileSync(modelProvidersPath, JSON.stringify({
                providers: [{ id: "fixture-openai-type", type: "openai", baseUrl: "https://example.invalid/v1", models: [{ name: "fixture-model" }] }],
            }));
            await catalog.providers.createProvider({
                name: "fixture-provider", typeId: "fixture-openai-type", class: "shared", secretRef: { apiKey: "fixture-key" },
            }, null, true);
            await catalog.providers.setClusterDefault({ provider: "fixture-provider", model: "fixture-provider:fixture-model", reasoning: null, context: null }, true);

            // Version 1.0.0 is what a workflow publication pinned: its package id and content hash.
            const v1 = await publishAgentPackageDir(ctx, {
                dir: writePackageVersion(path.join(fixtures, "v1"), "1.0.0"), scope: "shared", owner: OWNER, createdBy: "fixture@test", isAdmin: false,
            });
            const pinnedId = pinnedAgentPackageId(v1.packageId, v1.sha256);
            assertEqual(parsePinnedAgentPackageId(pinnedId)?.packageId, v1.packageId, "the pinned id names the package");
            assertEqual(parsePinnedAgentPackageId(v1.packageId), null, "an ordinary package id is not a pinned id");

            await withClient(env, {
                workerNodeId: `pkg-pinned-${env.runId}`,
                worker: { workerPool: "default", modelProvidersPath, agentPackages: { cacheDir, refreshIntervalMs: 0 } },
                client: { modelProvidersPath },
            }, async (_client, worker) => {
                // The package is republished: 1.1.0 is now the active version everywhere.
                const v11 = await publishAgentPackageDir(ctx, {
                    dir: writePackageVersion(path.join(fixtures, "v1.1"), "1.1.0"), scope: "shared", owner: OWNER, createdBy: "fixture@test", isAdmin: false,
                });
                assertEqual(v11.packageId, v1.packageId, "a republish keeps the package's id");
                await worker.refreshAgentPackages();
                const defaults = worker.sessionManager.workerDefaults;
                const activeBefore = pickAgentCopyForOwner(defaults.agentPromptLookup[AGENT], null);
                assert(activeBefore?.prompt.includes("version 1.1.0"), "the active version is the default copy");
                assertEqual(pickAgentCopyByPackageIdForOwner(defaults.agentPromptLookup[AGENT], pinnedId, null), undefined,
                    "an earlier revision is not served before it is asked for");

                // A session pinned to 1.0.0 asks for it: the worker installs it beside 1.1.0.
                assertEqual(await worker.ensurePinnedAgentPackageRevision(pinnedId), true, "the pinned revision is served");
                const entry = defaults.agentPromptLookup[AGENT];
                const pinned = pickAgentCopyByPackageIdForOwner(entry, pinnedId, null);
                assert(pinned, "the pinned binding resolves to the earlier revision");
                assert(pinned.prompt.includes("version 1.0.0") && !pinned.prompt.includes("version 1.1.0"), "the pinned copy has its own prompt");
                assert(pinned.prompt.includes("Triage notes of version 1.0.0.") && !pinned.prompt.includes("Triage notes of version 1.1.0."),
                    "the pinned copy composes its own revision's skill, never the active version's");
                assertEqual(pinned.pinnedRevision, v1.sha256, "the pinned copy names its revision");
                assertEqual(pinned.packageScope, "shared", "the pinned copy keeps its package's scope");

                // Everyone else keeps the active version: the default copy, the package's own binding and discovery.
                const active = pickAgentCopyForOwner(entry, null);
                assert(active.prompt.includes("version 1.1.0") && !active.pinnedRevision, "the default copy is still the active version");
                const bound = pickAgentCopyByPackageIdForOwner(entry, v1.packageId, null);
                assert(bound.prompt.includes("version 1.1.0"), "a binding to the package itself follows the active version");
                const listed = worker.loadedAgents.filter((agent) => agent.name === AGENT);
                assertEqual(listed.length, 1, "discovery lists the agent once");
                assert(listed[0].prompt.includes("version 1.1.0"), "discovery lists the active version");
                assert(!defaults.skills.some((skill) => String(skill.prompt ?? "").includes("version 1.0.0")),
                    "the shared skill catalog has only the active version's skill");
                assert(!defaults.getCapabilitySources().some((source) => source.id === pinnedId), "no capability source for the pinned revision");

                // Tool handlers: the pinned binding gets its own revision's, everyone else the active version's.
                const byPackage = worker.sessionManager.packageToolRegistry;
                assertEqual((await byPackage.get(pinnedId).get(TOOL).handler({})).version, "1.0.0", "the pinned revision's own tool handler");
                assertEqual((await byPackage.get(v1.packageId).get(TOOL).handler({})).version, "1.1.0", "the package binding's handler is the active one");
                assertEqual((await worker.sessionManager.toolRegistry.get(TOOL).handler({})).version, "1.1.0", "the flat registry keeps the active handler");

                // The revision survives later refreshes; asking again is answered at once.
                await worker.refreshAgentPackages({ force: true });
                assert(pickAgentCopyByPackageIdForOwner(defaults.agentPromptLookup[AGENT], pinnedId, null)?.prompt.includes("version 1.0.0"),
                    "a refresh keeps the pinned revision");
                assertEqual(await worker.ensurePinnedAgentPackageRevision(pinnedId), true);

                // A revision the registry does not have, and an ordinary package id, are not served.
                assertEqual(await worker.ensurePinnedAgentPackageRevision(pinnedAgentPackageId(v1.packageId, "0".repeat(64))), false,
                    "an unknown revision is not served");
                assertEqual(await worker.ensurePinnedAgentPackageRevision(v1.packageId), false, "an ordinary package id is not a pinned revision");

                // A disabled package serves no revision.
                await catalog.setAgentPackageEnabled("pinned-kit", false, OWNER, false);
                await worker.refreshAgentPackages();
                assertEqual(pickAgentCopyByPackageIdForOwner(worker.sessionManager.workerDefaults.agentPromptLookup[AGENT], pinnedId, null), undefined,
                    "a disabled package's pinned revision is no longer served");
                assertEqual(await worker.ensurePinnedAgentPackageRevision(pinnedId), false);
            });
        } finally {
            await catalog.close();
        }
    });
});
