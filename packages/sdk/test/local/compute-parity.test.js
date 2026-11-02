/**
 * A session whose agent runs elsewhere gets the same skill folders and the
 * same MCP servers as one that runs on the worker
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * One turn, in a real runtime, through the real handshake, with the
 * scripted model driving:
 *
 *   a. it reads a file out of a copied skill folder, at a path on its host
 *   b. it calls a tool on a deployment MCP server, which runs on the
 *      trusted side with the deployment's own configuration — and the
 *      worker-only value that configures it never reaches the host
 *   c. it calls a tool on a package's MCP server, which runs on the host,
 *      out of the copied package folder, with none of the worker's
 *      environment
 *   d. a second turn copies nothing again; changing the skill makes the
 *      next turn read the new text
 *   e. a server the deployment keeps away from these sessions is not in
 *      the session's map, and the session's events say why
 *
 * Run: npx vitest run test/local/compute-parity.test.js
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { createProcessComputeProvider } from "../../src/compute-process.ts";
import { computeCopyName } from "../../src/compute-mcp.ts";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";

const TIMEOUT = 300_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "compute-parity-owner", email: null, displayName: "Parity owner" };
/** A value only the worker has. Nothing the host can see may contain it. */
const SENTINEL = "worker-only-value-ddc41f6a";

function write(root, relative, content) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
}

/**
 * A small MCP server over its own input and output. It answers one tool,
 * and what it answers is a report about where it is running.
 */
function mcpServerSource(serverName, toolName, report) {
    return [
        "#!/usr/bin/env node",
        "const send = value => process.stdout.write(`${JSON.stringify(value)}\\n`);",
        "let buffer = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', chunk => {",
        "  buffer += chunk;",
        "  let newline = buffer.indexOf('\\n');",
        "  while (newline !== -1) {",
        "    const line = buffer.slice(0, newline).trim();",
        "    buffer = buffer.slice(newline + 1);",
        "    if (line) {",
        "      const message = JSON.parse(line);",
        `      const report = () => (${report});`,
        "      if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, "
            + `serverInfo: { name: ${JSON.stringify(serverName)}, version: '1.0.0' } } });`,
        `      else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: ${JSON.stringify(toolName)}, `
            + `description: 'Report where this server runs', inputSchema: { type: 'object', properties: {} } }] } });`,
        "      else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(report()) }] } });",
        "      else if (message.id != null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });",
        "    }",
        "    newline = buffer.indexOf('\\n');",
        "  }",
        "});",
        "",
    ].join("\n");
}

/** Every file under a folder, as one string, for a search. */
function readTree(dir) {
    if (!fs.existsSync(dir)) return "";
    let text = dir;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        text += `\n${full}`;
        if (entry.isDirectory()) text += `\n${readTree(full)}`;
        else if (entry.isFile()) {
            try { text += `\n${fs.readFileSync(full, "utf8")}`; } catch { /* not text, and so not the sentinel */ }
        }
    }
    return text;
}

/**
 * Every file the host has been sent, with when it was written. Names alone
 * would not notice a file sent again — it is named by its content, so it
 * lands in the same place — but the time it was written would change.
 */
function blobsSent(sharedDir) {
    const blobs = path.join(sharedDir, "copies", "blobs");
    if (!fs.existsSync(blobs)) return [];
    const stamps = [];
    for (const bucket of fs.readdirSync(blobs)) {
        const full = path.join(blobs, bucket);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const name of fs.readdirSync(full)) {
            stamps.push(`${name}@${fs.statSync(path.join(full, name)).mtimeMs}`);
        }
    }
    return stamps.sort();
}

async function registerTarget(env, label, kind) {
    const catalog = await createCatalog(env);
    try {
        await catalog.computeTargets.create({ name: `shared/${label}`, kind, class: "shared", displayName: label }, null, true);
    } finally {
        await catalog.close?.();
    }
}

describe("skills and MCP servers on a session that runs elsewhere", () => {
    it("copies the skill folders, keeps the deployment's servers here, and runs the package's on the host",
        { timeout: TIMEOUT }, async () => {
            const env = await getEnv();
            await registerTarget(env, "parity-process", "process");

            // ── The deployment: a skill folder and a catalog of servers ──
            const skillsRoot = path.join(env.baseDir, "parity-skills");
            write(skillsRoot, "parity-skill/SKILL.md", [
                "---", "name: parity-skill", "description: A skill a remote session must be able to read", "---",
                "", "PARITY_SKILL_BODY_ONE",
            ].join("\n"));

            const deploymentDir = path.join(env.baseDir, "parity-deployment-plugin");
            write(deploymentDir, "plugin.json", JSON.stringify({ name: "parity-deployment", version: "1.0.0" }));
            write(deploymentDir, "mcp-servers/catalog.js", mcpServerSource("parity-catalog", "catalog_report",
                "{ where: 'deployment', pid: process.pid, parent: process.ppid, "
                + "configured: process.env.PARITY_CATALOG_VALUE ? 'yes' : 'no', "
                + "caller: process.env.PILOTSWARM_CALLER_SESSION || 'none', "
                + "remoteCaller: process.env.PILOTSWARM_CALLER_RUNS_REMOTELY || 'no' }"));
            write(deploymentDir, ".mcp.json", JSON.stringify({
                // Configured with a worker value, exactly as it is today.
                parity_catalog: {
                    command: "node", args: ["./mcp-servers/catalog.js"], tools: ["*"],
                    env: { PARITY_CATALOG_VALUE: "${PARITY_WORKER_SENTINEL}" },
                },
                // The same server, kept away from sessions that run elsewhere.
                parity_offlimits: {
                    command: "node", args: ["./mcp-servers/catalog.js"], tools: ["*"], remote: false,
                },
            }));

            // ── A package: its own server, and an agent that names all three ──
            const packageDir = path.join(env.baseDir, "parity-kit");
            write(packageDir, "plugin.json", JSON.stringify({ name: "parity-kit", version: "1.0.0", description: "Parity fixtures" }));
            write(packageDir, "mcp-servers/records.js", mcpServerSource("parity-records", "records_report",
                "{ where: 'package', pid: process.pid, parent: process.ppid, cwd: process.cwd(), "
                + "tag: process.env.PARITY_RECORDS_TAG || 'none', "
                + "sawWorkerValue: process.env.PARITY_WORKER_SENTINEL ? 'yes' : 'no', "
                + "variables: Object.keys(process.env).length }"));
            write(packageDir, ".mcp.json", JSON.stringify({
                parity_package_records: {
                    command: "node", args: ["./mcp-servers/records.js"], tools: ["*"],
                    env: { PARITY_RECORDS_TAG: "from-the-package" },
                },
            }));
            write(packageDir, "agents/parity-agent.agent.md", [
                "---", "schemaVersion: 2", "version: 1.0.0", "name: parity-agent",
                "description: Exercises skills and MCP servers on a compute host",
                "mcpServers:", "  - parity_catalog", "  - parity_offlimits", "  - parity_package_records",
                "---", "", "You are the parity agent.",
            ].join("\n"));

            const catalog = await createCatalog(env);
            const artifactStore = new FilesystemArtifactStore(path.join(path.dirname(env.sessionStateDir), "artifacts"));
            await publishAgentPackageDir({ catalog, artifactStore }, {
                dir: packageDir, scope: "shared", owner: OWNER, createdBy: "parity@test", isAdmin: false,
            });

            const provider = createProcessComputeProvider({ rootDir: path.join(env.baseDir, "parity-compute") });
            const hostSkillDir = () => path.join(provider.hosts()[0].sharedDir, "copies", "folders", computeCopyName("skills", skillsRoot));

            const declaredTools = [];
            let skillText = "";
            let catalogReport = "";
            let recordsReport = "";

            /** The name the runtime gave an MCP server's tool this turn. */
            const toolNamed = (body, needle) => (body.tools ?? [])
                .map((tool) => tool?.function?.name ?? tool?.name)
                .find((name) => typeof name === "string" && name.includes(needle));

            const respond = (body, position) => {
                declaredTools.push((body.tools ?? []).map((tool) => tool?.function?.name ?? tool?.name));
                if (position.step === 0) {
                    return { tools: [{ name: "bash", args: { command: `cat ${hostSkillDir()}/parity-skill/SKILL.md`, description: "read the copied skill" } }] };
                }
                if (position.step === 1) {
                    skillText = position.toolResults.join("\n");
                    const name = toolNamed(body, "catalog_report");
                    if (!name) return { content: `no-catalog-tool:${JSON.stringify(declaredTools.at(-1))}` };
                    return { tools: [{ name, args: {} }] };
                }
                if (position.step === 2) {
                    catalogReport = position.toolResults.join("\n");
                    const name = toolNamed(body, "records_report");
                    if (!name) return { content: `no-records-tool:${JSON.stringify(declaredTools.at(-1))}` };
                    return { tools: [{ name, args: {} }] };
                }
                recordsReport = position.toolResults.join("\n");
                return { content: "parity-done" };
            };

            const previousSentinel = process.env.PARITY_WORKER_SENTINEL;
            process.env.PARITY_WORKER_SENTINEL = SENTINEL;
            try {
                await withScriptedModel(env, {
                    respond,
                    worker: {
                        computeProviders: [provider],
                        pluginDirs: [deploymentDir],
                        skillDirectories: [skillsRoot],
                        agentPackages: { cacheDir: path.join(env.baseDir, "parity-package-cache"), refreshIntervalMs: 0 },
                    },
                }, async ({ client, qualifiedModel }) => {
                    const session = await client.createSessionForAgent("parity-agent", {
                        model: qualifiedModel, computeTarget: "shared/parity-process", owner: OWNER,
                    });
                    expect(await session.sendAndWait("first prompt", TIMEOUT)).toBe("parity-done");

                    const host = provider.hosts()[0];
                    expect(host, "the turn ran on a host of its own").toBeTruthy();

                    // (a) The skill folder was copied, and the runtime read it
                    // at a path on its host.
                    console.log(`[parity] skill read: ${skillText.trim().slice(0, 200)}`);
                    expect(skillText).toContain("PARITY_SKILL_BODY_ONE");
                    expect(fs.existsSync(path.join(hostSkillDir(), "parity-skill", "SKILL.md"))).toBe(true);

                    // (b) The deployment's server ran on the trusted side, with
                    // the configuration it has today, and was told who called.
                    console.log(`[parity] deployment server: ${catalogReport.trim().slice(0, 300)}`);
                    const catalogSaid = JSON.parse(catalogReport.match(/\{[\s\S]*\}/)[0]);
                    expect(catalogSaid.where).toBe("deployment");
                    expect(catalogSaid.parent, "started by the worker's own process").toBe(process.pid);
                    expect(catalogSaid.configured, "with the worker value its configuration asks for").toBe("yes");
                    expect(catalogSaid.caller).toBe(session.sessionId);
                    expect(catalogSaid.remoteCaller).toBe("1");

                    // …and the worker-only value never reached the host.
                    const everythingTheHostSees = readTree(path.dirname(host.homeDir));
                    expect(everythingTheHostSees.includes(SENTINEL),
                        "the worker-only value must not appear anywhere the host can see").toBe(false);

                    // (c) The package's server ran on the host, out of the
                    // copy, with only what its own entry states.
                    console.log(`[parity] package server: ${recordsReport.trim().slice(0, 300)}`);
                    const recordsSaid = JSON.parse(recordsReport.match(/\{[\s\S]*\}/)[0]);
                    expect(recordsSaid.where).toBe("package");
                    expect(recordsSaid.parent, "started by the runtime on the host, not by the worker").not.toBe(process.pid);
                    expect(recordsSaid.cwd.startsWith(path.join(host.sharedDir, "copies", "folders")),
                        `the package server runs out of the copy, got ${recordsSaid.cwd}`).toBe(true);
                    expect(recordsSaid.tag).toBe("from-the-package");
                    expect(recordsSaid.sawWorkerValue, "no worker environment reaches a package's server").toBe("no");

                    // (e) The server the deployment keeps away is not there,
                    // and the session's events say why.
                    const names = declaredTools.flat().join(" ");
                    expect(names).not.toContain("offlimits");
                    const events = await (async () => {
                        const cms = await createCatalog(env);
                        try { return await cms.getSessionEvents(session.sessionId, 0, 500); } finally { await cms.close?.(); }
                    })();
                    const notice = events.find((event) => event.eventType === "session.compute_capabilities");
                    expect(notice, "the session records what it could not have").toBeTruthy();
                    expect(JSON.stringify(notice.data)).toMatch(/parity_offlimits/);
                    expect(JSON.stringify(notice.data)).toMatch(/keeps this server away/);

                    // (d) A second turn copies nothing again.
                    const afterFirst = blobsSent(host.sharedDir);
                    expect(afterFirst.length).toBeGreaterThan(0);
                    skillText = "";
                    expect(await session.sendAndWait("second prompt", TIMEOUT)).toBe("parity-done");
                    expect(blobsSent(host.sharedDir), "an unchanged folder is not sent again").toEqual(afterFirst);
                    expect(skillText).toContain("PARITY_SKILL_BODY_ONE");

                    // …and a changed skill is read as it now stands.
                    write(skillsRoot, "parity-skill/SKILL.md", [
                        "---", "name: parity-skill", "description: A skill a remote session must be able to read", "---",
                        "", "PARITY_SKILL_BODY_TWO",
                    ].join("\n"));
                    skillText = "";
                    expect(await session.sendAndWait("third prompt", TIMEOUT)).toBe("parity-done");
                    expect(skillText).toContain("PARITY_SKILL_BODY_TWO");
                    expect(skillText).not.toContain("PARITY_SKILL_BODY_ONE");
                    const afterChange = blobsSent(host.sharedDir);
                    expect(afterChange).toEqual(expect.arrayContaining(afterFirst));
                    expect(afterChange.length, "only what changed is sent").toBe(afterFirst.length + 1);
                });
            } finally {
                process.env.PARITY_WORKER_SENTINEL = previousSentinel;
                if (previousSentinel === undefined) delete process.env.PARITY_WORKER_SENTINEL;
                await provider.stopAll();
                await catalog.close?.();
            }
        });
});
