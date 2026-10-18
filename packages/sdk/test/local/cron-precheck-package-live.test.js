/**
 * Real PostgreSQL/Duroxide/worker/CLI cron, with an inspected, explicitly
 * approved/activated callback package. Only inference and queue data are synthetic.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog, waitForEventCount } from "../helpers/cms-helpers.js";
import { scriptTurns } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";

const OWNER = { provider: "test", subject: "cron-precheck-package-owner" };
const ADMIN = { principal: { provider: "test", subject: "fixture-admin" }, isAdmin: true };
const AGENT = "queue-poller";
const REASON = "Run the fixture queue cycle (scope=both)";
const KICKOFF = "start the fixture queue cycle";
const getEnv = useSuiteEnv(import.meta.url);

function writePackage(dir, statePath, eventsPath, mcp) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "precheck-kit", version: "1.0.0", description: "supervised cron fixture",
        callbacks: { queue_gate: { agents: [AGENT], tools: [], mcpServers: mcp ? ["queue"] : [] } },
        cronPrechecks: { "queue-gate": { callback: "queue_gate", timeoutMs: 10_000 } },
    }));
    fs.writeFileSync(path.join(dir, "agents", `${AGENT}.agent.md`), [
        "---", `name: ${AGENT}`, "description: Fixture queue poller", "schemaVersion: 2", "version: 1.0.0",
        "tools: []", ...(mcp ? ["mcpServers: [queue]"] : []),
        "cronPrechecks:", '  - reasonPrefix: "Run the fixture queue cycle"', "    precheck: queue-gate",
        "---", "Poll the fixture queue.",
    ].join("\n"));
    const mark = `const mark=(kind, facts={})=>fs.appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({kind,pid:process.pid,...facts})+"\\n");`;
    fs.writeFileSync(path.join(dir, "tools", "worker-module.js"), `
import fs from "node:fs";
${mark}
mark("import");
export function createTools(){mark("tool-factory");return [];}
export function createCallbacks(){
 mark("callback-factory");
 return [{name:"queue_gate",handler:async(facts,context)=>{
  mark("callback",facts);
  ${mcp ? 'const result=await context.callMcp("queue","tools/call",{name:"queue_status",arguments:{scope:"both"}}); const hasWork=result.structuredContent?.hasWork;'
      : `const hasWork=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},"utf8")).hasWork;`}
  if(typeof hasWork!=="boolean")throw new Error("Invalid queue data");
  return {action:hasWork?"run":"skip",detail:hasWork?"one job":"queue empty"};
 }}];
}`);
    if (mcp) {
        fs.mkdirSync(path.join(dir, "mcp-servers"));
        fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
            queue: { command: "node", args: ["mcp-servers/queue.mjs"] },
        }));
        fs.writeFileSync(path.join(dir, "mcp-servers", "queue.mjs"), `
import fs from "node:fs";
import {createInterface} from "node:readline";
${mark}
mark("mcp-start");
createInterface({input:process.stdin}).on("line",line=>{
 const request=JSON.parse(line);if(!request.id)return;
 let result={};
 if(request.method==="initialize")result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"queue",version:"1"}};
 if(request.method==="tools/list")result={tools:[{name:"queue_status",description:"queue",inputSchema:{type:"object"}}]};
 if(request.method==="tools/call"){
  mark("mcp-call",{arguments:request.params.arguments});
  const hasWork=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},"utf8")).hasWork;
  result={content:[{type:"text",text:JSON.stringify({hasWork})}],structuredContent:{hasWork}};
 }
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
});`);
    }
    return dir;
}

describe("approved supervised package cron (real worker)", () => {
    it.each([false, true])("MCP=%s: pending executes nothing, approved idle cycles make zero new model requests", { timeout: 240_000 }, async mcp => {
        const env = await getEnv();
        const statePath = path.join(env.baseDir, `queue-${mcp}.json`);
        const eventsPath = path.join(env.baseDir, `events-${mcp}.jsonl`);
        fs.writeFileSync(statePath, JSON.stringify({ hasWork: false }));
        const events = () => fs.existsSync(eventsPath)
            ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
        const catalog = await createCatalog(env);
        const artifactStore = new FilesystemArtifactStore(path.join(path.dirname(env.sessionStateDir), "artifacts"));
        try {
            const published = await publishAgentPackageDir({ catalog, artifactStore }, {
                dir: writePackage(path.join(env.baseDir, `precheck-kit-${mcp}`), statePath, eventsPath, mcp),
                scope: "shared", owner: OWNER, createdBy: "fixture@test", isAdmin: false,
            });
            const identity = { packageId: published.packageId, versionId: published.versionId, sha256: published.sha256 };
            const respond = scriptTurns([
                [{ tools: [{ name: "cron", args: { seconds: 15, reason: REASON } }] }, { content: "armed" }],
                [{ content: "cycle ran" }],
            ]);
            await withScriptedModel(env, {
                respond,
                worker: { artifactStore, agentPackages: { cacheDir: path.join(env.baseDir, `cache-${mcp}`), refreshIntervalMs: 0 } },
            }, async ({ client, worker, model }) => {
                await worker.refreshAgentPackages({ force: true });
                expect(events()).toEqual([]);
                const review = (await catalog.packageReviews.list(ADMIN)).find(row => row.versionId === published.versionId);
                expect(review.decision).toBe("pending");
                expect(review.inspection.execution.cronPrechecks["queue-gate"]).toMatchObject({ callback: "queue_gate" });
                await catalog.packageReviews.decide(ADMIN, { ...identity, expectedRevision: 1, decision: "approved", reason: "fixture immutable content review" });
                expect(events()).toEqual([]);
                await catalog.packageReviews.activate(ADMIN, {
                    ...identity, expectedReviewRevision: 2, expectedActivationRevision: 1,
                    expectedActiveVersionId: null, reason: "fixture explicit activation",
                });
                await worker.refreshAgentPackages({ force: true });
                // The local harness forwards this discovery snapshot at startup;
                // refresh it after the deliberately post-start admin activation.
                client.config.allowedAgentNames = [...worker.allowedAgentNames];
                const session = await client.createSessionForAgent(AGENT, { title: "supervised-cron", owner: OWNER });
                await session.send(KICKOFF);
                const [started] = await waitForEventCount(catalog, session.sessionId, "session.cron_started", 1, 60_000);
                expect(started.data).toMatchObject({ reason: REASON, precheck: "queue-gate" });
                const armedRequests = model.sessionRequests(KICKOFF).length;
                await waitForEventCount(catalog, session.sessionId, "session.cron_precheck", 2, 75_000);
                expect(model.sessionRequests(KICKOFF).length).toBe(armedRequests);
                const callbacks = events().filter(event => event.kind === "callback");
                expect(callbacks.slice(0, 2).map(call => [call.sessionId, call.reason, call.consecutiveSkips])).toEqual([
                    [session.sessionId, REASON, 0], [session.sessionId, REASON, 1],
                ]);
                expect(callbacks.every(call => call.pid !== process.pid)).toBe(true);
                for (const kind of ["import", "tool-factory", "callback-factory"]) {
                    const records = events().filter(event => event.kind === kind);
                    expect(records).toHaveLength(1);
                    expect(records[0].pid).toBe(callbacks[0].pid);
                }
                if (mcp) {
                    expect(events().filter(e => e.kind === "mcp-call").length).toBeGreaterThanOrEqual(2);
                    expect(events().filter(e => e.kind === "mcp-start")).toHaveLength(1);
                }
                fs.writeFileSync(`${statePath}.next`, JSON.stringify({ hasWork: true }));
                fs.renameSync(`${statePath}.next`, statePath);
                await waitForEventCount(catalog, session.sessionId, "session.cron_precheck", 3, 45_000);
                const decisions = (await catalog.getSessionEvents(session.sessionId, undefined, 500, ["session.cron_precheck"])).map(e => e.data);
                expect(decisions.slice(0, 2).map(e => [e.outcome, e.skipped])).toEqual([["skip", true], ["skip", true]]);
                expect(decisions.some(e => e.outcome === "run" && !e.skipped)).toBe(true);
                await catalog.packageReviews.decide(ADMIN, { ...identity, expectedRevision: 2, decision: "revoked", reason: "fixture warm denial" });
                const before = events();
                await worker.refreshAgentPackages({ force: true });
                expect(events()).toEqual(before);
            });
        } finally { await catalog.close(); }
    });
});
