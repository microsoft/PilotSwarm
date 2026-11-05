import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { CopilotClient, CopilotRequestHandler, RuntimeConnection, approveAll } from "@github/copilot-sdk";
import { ComputeNativeStateHost, FilesystemSessionStore, stageNativeCapture, readNativeStaging } from "pilotswarm-sdk";

const require = createRequire(import.meta.url);
const osEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["path", "systemroot", "windir", "temp", "tmp", "comspec", "pathext"].includes(key.toLowerCase())));

async function until(description, read, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const result = await read(); if (result) return result; await delay(25); }
    throw new Error(`Timed out waiting for ${description}`);
}

// This qualifies one controlled Windows Job Object profile, not hostile host
// containment. Model inference is synthetic loopback; the runtime gets no keys.
test("real SDK1.0.13/CLI1.0.83 native capture and cold resume under an enforced Windows writer scope",
    { skip: process.platform !== "win32", timeout: 180_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ps-native-job-"));
    const home = path.join(root, "home"), work = path.join(root, "repo"), tools = path.join(root, "supervisor");
    await Promise.all([home, work, tools].map(directory => fs.mkdir(directory)));
    const environment = { ...osEnvironment(), HOME: home, USERPROFILE: home, COPILOT_HOME: home,
        APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local"),
        XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
        GH_CONFIG_DIR: path.join(home, "gh"), COPILOT_DISABLE_KEYTAR: "1", DO_NOT_TRACK: "1",
        COPILOT_OTEL_ENABLED: "false", DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
        DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "false", DOTNET_CLI_HOME: path.join(root, "dotnet-home"),
        DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", MSBUILDDISABLENODEREUSE: "1",
        DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER: "1", DOTNET_SKIP_WORKLOAD_INTEGRITY_CHECK: "1",
        ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)",
        ProgramW6432: "C:\\Program Files", ProgramData: path.join(root, "program-data"),
        ALLUSERSPROFILE: path.join(root, "program-data"), NUGET_PACKAGES: path.join(root, "nuget"),
        NUGET_HTTP_CACHE_PATH: path.join(root, "nuget-http") };
    const dotnet = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "dotnet", "dotnet.exe");
    const children = [], clients = [], pending = new Map(), hooks = [], requests = [];
    let broker, server, seq = 0, generation = 0, currentClient, currentSession, writerPid, expectedRestore;
    let authority = "fixture-authority-one";
    const scope = (op, args = {}) => new Promise((resolve, reject) => {
        const id = ++seq; pending.set(id, { resolve, reject });
        broker.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
    t.after(async () => {
        let scopeEmpty = false;
        try {
            if (broker && broker.exitCode === null) {
                assert.deepEqual((await scope("stop")).members, []);
                scopeEmpty = true;
                for (const client of clients) await client.forceStop();
                const exited = new Promise(resolve => broker.once("exit", resolve));
                broker.stdin.end(); await exited;
            }
        } finally {
            if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
            for (const child of children) if (child.exitCode === null && child.signalCode === null) {
                const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited;
            }
            await fs.rm(root, { recursive: true, force: true });
            await assert.rejects(fs.stat(root), { code: "ENOENT" });
            console.log(JSON.stringify({ cleanup: { scopeStarted: Boolean(broker), kernelJobEmpty: scopeEmpty,
                supervisorExited: broker ? broker.exitCode !== null : null, temporaryDirectoryRemoved: true } }));
        }
    });
    await fs.access(dotnet);
    for (const file of ["WindowsJob.cs", "WindowsJob.csproj", "NuGet.Config"]) {
        await fs.copyFile(new URL(`../fixtures/compute-native-runtime/${file}`, import.meta.url), path.join(tools, file));
    }
    const build = spawn(dotnet, ["build", path.join(tools, "WindowsJob.csproj"), "--configfile", path.join(tools, "NuGet.Config"),
        "--disable-build-servers", "-p:UseSharedCompilation=false", "--nologo", "-o", path.join(tools, "bin")],
        { cwd: tools, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    children.push(build);
    let buildOutput = "";
    build.stdout.on("data", bytes => { buildOutput += bytes; }); build.stderr.on("data", bytes => { buildOutput += bytes; });
    assert.equal(await new Promise((resolve, reject) => { build.once("exit", resolve); build.once("error", reject); }), 0, buildOutput);
    assert.doesNotMatch(buildOutput, /Installed an ASP\.NET Core HTTPS|added.*(?:PATH|path)/);
    const dll = path.join(tools, "bin", "WindowsJob.dll");
    const shortHome = execFileSync(dotnet, [dll, "--short-path", home], { cwd: work, env: environment, encoding: "utf8" }).trim();
    assert.equal(await fs.realpath(shortHome), await fs.realpath(home), "The short spelling must name the same owned native home");
    broker = spawn(dotnet, [dll], { cwd: work, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    children.push(broker);
    let brokerError = "";
    broker.stderr.on("data", bytes => { brokerError += bytes; });
    createInterface({ input: broker.stdout }).on("line", line => {
        const reply = JSON.parse(line), operation = pending.get(reply.id); pending.delete(reply.id);
        if (reply.ok) operation.resolve(reply.result); else operation.reject(new Error(reply.error));
    });
    broker.on("exit", () => { for (const operation of pending.values()) operation.reject(new Error("Writer supervisor exited: " + brokerError)); });
    const sessionId = randomUUID(), sessionDirectory = path.join(home, "session-state", sessionId);
    const writerFile = path.join(sessionDirectory, "files", "writer.log");
    const command = `& '${dotnet}' '${dll}' --spawn-writer '${writerFile}'`;
    server = createServer(async (req, res) => {
        try {
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ body, authorization: req.headers.authorization });
            const last = body.messages.at(-1), launching = last.role === "user" && JSON.stringify(last.content).includes("spawn-owned-writer");
            let message;
            if (launching) {
                const tool = body.tools.find(item => item.function?.name === "powershell");
                assert.ok(tool, "The pinned Windows runtime must advertise its real powershell tool");
                const args = { command, description: "Start the owned descendant writer" };
                assert.ok((tool.function.parameters.required ?? []).every(key => Object.hasOwn(args, key)), "Unexpected pinned powershell schema");
                message = { role: "assistant", content: null, tool_calls: [{ id: "owned-writer", type: "function",
                    function: { name: "powershell", arguments: JSON.stringify(args) } }] };
            } else message = { role: "assistant", content: "Native checkpoint marker-one: accepted." };
            const finish = launching ? "tool_calls" : "stop", usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };
            if (body.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                const delta = launching ? { ...message, tool_calls: message.tool_calls.map(call => ({ index: 0, ...call })) } : message;
                for (const [part, reason] of [[delta, null], [{}, finish]]) res.write(`data: ${JSON.stringify({
                    id: "native-" + requests.length, object: "chat.completion.chunk", model: body.model,
                    choices: [{ index: 0, delta: part, finish_reason: reason }], ...(reason ? { usage } : {}),
                })}\n\n`);
                res.end("data: [DONE]\n\n");
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "native-" + requests.length, object: "chat.completion", model: body.model,
                    choices: [{ index: 0, message, finish_reason: finish }], usage }));
            }
        } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const modelUrl = `http://127.0.0.1:${server.address().port}/v1`;
    class LoopbackAuthority extends CopilotRequestHandler {
        async sendRequest(request) {
            assert.equal(new URL(request.url).origin, new URL(modelUrl).origin);
            const guarded = new Request(request);
            guarded.headers.set("authorization", "Bearer " + authority);
            return fetch(guarded);
        }
    }
    const profile = { id: "sdk-1.0.13-cli-1.0.83-windows-job-v1", sdkVersion: "1.0.13", runtimeVersion: "1.0.83",
        roots: [
            { name: "session", directory: path.join(shortHome, "session-state", sessionId), requiredFiles: ["workspace.yaml", "events.jsonl"] },
            { name: "global", directory: shortHome, requiredFiles: ["session-store.db", "config.json"],
                includeFiles: ["config.json", "session-store.db", "session-store.db-wal", "session-store.db-shm"], databases: ["session-store.db"] },
        ], unsupportedFeatures: ["same-process SDK task agents", "warm process continuity", "background-process continuity", "hostile host containment"] };
    let sdkDirectory = path.dirname(require.resolve("@github/copilot-sdk")), sdkVersion;
    for (let depth = 0; depth < 4; depth++, sdkDirectory = path.dirname(sdkDirectory)) {
        const metadata = await fs.readFile(path.join(sdkDirectory, "package.json"), "utf8").catch(error => {
            if (error.code === "ENOENT") return null; throw error;
        });
        if (metadata) { const manifest = JSON.parse(metadata); if (manifest.name === "@github/copilot-sdk") { sdkVersion = manifest.version; break; } }
    }
    assert.equal(sdkVersion, profile.sdkVersion);
    const host = new ComputeNativeStateHost({ sessionId, profile, supervisor: {
        async prepare() {
            generation++;
            if (generation > 1) {
                for (const file of expectedRestore) assert.deepEqual(await fs.readFile(path.join(home, file.path)), Buffer.from(file.data, "base64"),
                    "Global state must be restored from the accepted archive before native writers start");
            }
            const log = path.join(root, `runtime-${generation}.log`), token = randomUUID();
            const cli = path.join(path.dirname(require.resolve("@github/copilot/package.json")), "npm-loader.js");
            await scope("start", { executable: process.execPath, arguments: [cli, "--headless", "--no-auto-update", "--no-auto-login"],
                environment: { ...environment, COPILOT_CONNECTION_TOKEN: token }, directory: work, output: log });
            const port = await until("native runtime listener", async () => {
                const text = await fs.readFile(log, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
                const port = Number(text.match(/listening on port (\d+)/i)?.[1]) || null;
                if (!port && (await scope("inspect")).members.length === 0) throw new Error("Native runtime exited before listening: " + text.slice(-4000));
                return port;
            }, 120_000);
            currentClient = new CopilotClient({ connection: RuntimeConnection.forUri(`127.0.0.1:${port}`, { connectionToken: token }),
                logLevel: "error", requestHandler: new LoopbackAuthority() });
            clients.push(currentClient); await currentClient.start();
            assert.equal((await currentClient.getStatus()).version, profile.runtimeVersion);
            return { runtimeAddress: `127.0.0.1:${port}`, connectionToken: token, runtimeGeneration: `job-${generation}` };
        },
        async checkpoint(identity) {
            const baseline = hooks.length;
            await currentClient.rpc.sessions.save({ sessionId });
            const before = (await scope("inspect")).members;
            if (generation === 1) assert.ok(before.includes(writerPid), "A live descendant must still belong to the job after its launcher exits");
            assert.deepEqual((await scope("stop")).members, []);
            assert.equal(hooks.length, baseline, "Flush/controlled stop must not add per-turn session-end hooks");
            return { identity, runtimeGeneration: `job-${generation}`, barrierId: `barrier-${generation}`,
                kind: "runtime-stopped", evidence: { mechanism: "Windows Job Object", activeProcesses: 0, membersBefore: before } };
        },
        async endCheckpoint() { assert.deepEqual((await scope("inspect")).members, []); },
        async retire() { assert.deepEqual((await scope("stop")).members, []); return { runtimeGeneration: `job-${generation}`, evidence: { activeProcesses: 0 } }; },
    } });
    const config = { sessionId, workingDirectory: work, model: "gpt-5.4", streaming: false, enableSessionTelemetry: false,
        provider: { type: "openai", wireApi: "completions", baseUrl: modelUrl, apiKey: "placeholder-only" },
        availableTools: ["powershell"], excludedTools: ["task"], onPermissionRequest: approveAll,
        hooks: { onSessionEnd: input => { hooks.push(input.reason); } } };
    const identity = turn => ({ sessionId, transcriptEpoch: 0, turnKey: turn, attemptId: "attempt-" + turn,
        workerNodeId: "owned-controller", generation: "admission-" + turn });
    const first = identity("one");
    await host.prepare(first);
    currentSession = await currentClient.createSession(config);
    await fs.mkdir(path.dirname(writerFile), { recursive: true });
    const artifact = Buffer.from([0, 255, 13, 10]);
    await host.writeArtifact(first, "path-alias.bin", artifact.toString("base64"), createHash("sha256").update(artifact).digest("hex"));
    assert.deepEqual(Buffer.from((await host.readArtifact(first, "path-alias.bin")).data, "base64"), artifact);
    await fs.writeFile(path.join(work, "independent-edit"), "must survive");
    await fs.mkdir(path.join(home, "unselected-host-state"));
    await fs.writeFile(path.join(home, "unselected-host-state", "sentinel"), "leave untouched");
    const reply = await currentSession.sendAndWait({ prompt: "spawn-owned-writer for native-checkpoint-one" }, 30_000);
    assert.match(reply.data.content, /marker-one/);
    await until("normal-turn session-end baseline", () => hooks.length === 1);
    const serialized = JSON.stringify(requests.map(request => request.body.messages));
    const match = serialized.match(/writerPid\\*"\s*:\s*(\d+)/);
    const toolOutput = requests.flatMap(request => request.body.messages.filter(message => message.role === "tool")).map(message => message.content);
    assert.ok(match, "Real native tool output must report the owned writer PID: " + JSON.stringify(toolOutput).slice(0, 4000));
    writerPid = Number(match[1]);
    assert.match(serialized, /breakawayBlocked\\*":true/);
    await until("descendant's committed writes", async () => (await fs.readFile(writerFile, "utf8")).split("\n").length > 2);
    const barrier = await host.beginCheckpoint(first);
    assert.deepEqual((await scope("inspect")).members, [], "Trusted verification precedes export");
    const capture = await host.exportState(first, barrier.barrierId);
    expectedRestore = capture.state.roots.global.files;
    assert.ok(capture.state.roots.global.files.some(file => file.path === "session-store.db-wal" && file.size > 0));
    for (const tree of Object.values(capture.state.roots)) for (const file of tree.files) {
        assert.equal(Buffer.from(file.data, "base64").includes(Buffer.from("fixture-authority-one")), false);
    }
    const cache = path.join(root, "worker");
    await fs.mkdir(cache);
    await stageNativeCapture(path.join(cache, sessionId), capture.state, { sessionId, profile });
    const validation = path.join(root, "sqlite-inspection");
    await fs.mkdir(validation);
    for (const suffix of ["", "-wal", "-shm"]) {
        try { await fs.copyFile(path.join(cache, sessionId, ".ps-native-roots", "global", "session-store.db" + suffix),
            path.join(validation, "session-store.db" + suffix)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const db = new DatabaseSync(path.join(validation, "session-store.db"), { readOnly: true });
    let rows;
    try {
        assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        const columns = db.prepare("PRAGMA table_info(sessions)").all().map(row => row.name);
        const key = columns.includes("id") ? "id" : "session_id";
        rows = db.prepare(`SELECT * FROM sessions WHERE "${key}"=?`).all(sessionId);
        assert.equal(rows.length, 1, "The actual global SQLite session record must survive");
    } finally { db.close(); }
    const store = new FilesystemSessionStore(path.join(root, "archives"), cache);
    assert.equal((await store.commitSnapshot(sessionId, { baseVersion: 0, turnKey: first.turnKey })).version, 1);
    await host.endCheckpoint(first, barrier.barrierId, "committed");
    await host.retire(first);
    await currentClient.forceStop();
    await fs.rm(path.join(cache, sessionId), { recursive: true });
    await store.hydrateSnapshot(sessionId);
    const restored = await readNativeStaging(path.join(cache, sessionId), { sessionId, profile });
    assert.deepEqual(restored, capture.state, "SQLite inspection must not mutate the accepted native payload");
    await fs.writeFile(path.join(sessionDirectory, "unaccepted"), "must be removed");
    await fs.writeFile(path.join(home, "session-store.db"), "unaccepted database");
    authority = "fixture-authority-two";
    const second = identity("two");
    await host.prepare(second, restored);
    await assert.rejects(host.retire(first), /not current/);
    await assert.rejects(fs.stat(path.join(sessionDirectory, "unaccepted")), { code: "ENOENT" });
    currentSession = await currentClient.resumeSession(sessionId, config);
    const messages = await currentSession.getEvents();
    assert.match(JSON.stringify(messages), /native-checkpoint-one/);
    await currentSession.sendAndWait({ prompt: "native-checkpoint-two, retain marker-one" }, 30_000);
    await until("second normal-turn hook", () => hooks.length === 2);
    assert.equal(requests.at(-1).authorization, "Bearer fixture-authority-two");
    assert.deepEqual(requests.slice(0, 2).map(request => request.authorization),
        ["Bearer fixture-authority-one", "Bearer fixture-authority-one"]);
    assert.equal(requests.length, 3, "The cold-resumed conversation must not replay the first tool/model turn");
    const secondBarrier = await host.beginCheckpoint(second);
    assert.deepEqual((await scope("inspect")).members, []);
    const secondCapture = await host.exportState(second, secondBarrier.barrierId);
    for (const tree of Object.values(secondCapture.state.roots)) for (const file of tree.files) {
        for (const secret of ["fixture-authority-one", "fixture-authority-two"]) {
            assert.equal(Buffer.from(file.data, "base64").includes(Buffer.from(secret)), false);
        }
    }
    expectedRestore = secondCapture.state.roots.global.files;
    await stageNativeCapture(path.join(cache, sessionId), secondCapture.state, { sessionId, profile });
    assert.equal((await store.commitSnapshot(sessionId, { baseVersion: 1, turnKey: second.turnKey })).version, 2);
    await host.endCheckpoint(second, secondBarrier.barrierId, "committed");
    await host.retire(second); await currentClient.forceStop();
    const coldCache = path.join(root, "new-worker");
    await fs.mkdir(coldCache);
    const coldStore = new FilesystemSessionStore(path.join(root, "archives"), coldCache);
    await coldStore.hydrateSnapshot(sessionId);
    const secondRestore = await readNativeStaging(path.join(coldCache, sessionId), { sessionId, profile });
    assert.deepEqual(secondRestore, secondCapture.state);
    await fs.writeFile(path.join(home, "session-store.db"), "another unaccepted database");
    await host.prepare(identity("three"), secondRestore);
    currentSession = await currentClient.resumeSession(sessionId, config);
    assert.match(JSON.stringify(await currentSession.getEvents()), /native-checkpoint-two/);
    assert.equal(hooks.length, 2, "Two cold restores must not re-fire the completed turn hooks");
    const beforeShutdown = hooks.length;
    await currentSession.rpc.shutdown({ type: "routine" });
    assert.equal(hooks.length, beforeShutdown, "Routine shutdown of this terminal session must not duplicate its completed-turn hooks");
    assert.equal(await fs.readFile(path.join(work, "independent-edit"), "utf8"), "must survive");
    assert.equal(await fs.readFile(path.join(home, "unselected-host-state", "sentinel"), "utf8"), "leave untouched");
    assert.equal(generation, 3);
    console.log(JSON.stringify({ sdkVersion: profile.sdkVersion, runtimeVersion: profile.runtimeVersion, profile: profile.id,
        nativeRoots: profile.roots.map(root => ({ name: root.name, directory: root.directory, selectedFiles: root.includeFiles ?? "complete session tree" })),
        globalSessionRows: rows.length, hookReasons: hooks, runtimeGenerations: generation, coldRestores: 2,
        writerBoundary: "kernel job empty; ordinary descendants included; breakaway denied",
        firstCaptureMembers: barrier.evidence.membersBefore, modelRequests: requests.length, sqliteIntegrity: "ok",
        nativeHomeUsesShortAlias: shortHome !== await fs.realpath(home),
        limits: profile.unsupportedFeatures }));
});
