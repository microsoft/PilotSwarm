import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { killProcessTree } from "../process-tree.js";
import type { ScriptRuntime, WorkflowScriptState } from "./compiler.js";
import { WorkflowExecutionError, type ScriptToolCall } from "./executor.js";

/** Largest JSON a node may hand to the next node (it is stored in durable history). */
export const SCRIPT_NODE_MAX_OUTPUT_BYTES = 256 * 1024;
/** Most tool calls one node execution may make. */
export const SCRIPT_NODE_MAX_TOOL_CALLS = 500;
const RPC_MAX_BODY_BYTES = 1024 * 1024;
const STREAM_TAIL_BYTES = 16 * 1024;

/** Environment variables a script inherits from the worker. Everything else is dropped. */
const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"];

export type ScriptResultSource = "reported" | "stdout" | "exit" | "timeout" | "cancelled";

const CANCEL_POLL_MS = 250;

export interface ScriptToolCallRecord {
    name: string;
    ok: boolean;
    durationMs: number;
    error?: string;
}

export interface RunScriptNodeRequest {
    sessionId: string;
    workflowName: string;
    node: WorkflowScriptState;
    inputs: Record<string, unknown>;
    priorOutput: unknown;
    step: number;
    /** Routes one tool call to the workflow session's tool set. */
    callTool: (call: ScriptToolCall) => Promise<unknown>;
    /** True once the workflow stopped waiting for this node (cancel, complete or delete). */
    isCancelled?: () => boolean;
}

export interface RunScriptNodeResult {
    outcome: string;
    output: unknown;
    resultSource: ScriptResultSource;
    exitCode: number | null;
    durationMs: number;
    stdoutTail: string;
    stderrTail: string;
    toolCalls: ScriptToolCallRecord[];
}

export interface ScriptRunnerOptions {
    /** Executable per runtime. Defaults: node = this Node binary, python = python3, powershell = pwsh. */
    executables?: Partial<Record<ScriptRuntime, string>>;
}

const NODE_PRELUDE = `import { readFileSync as __psReadFileSync } from "node:fs";
import { createRequire as __psCreateRequire } from "node:module";
const require = __psCreateRequire(import.meta.url);
const context = JSON.parse(__psReadFileSync(0, "utf8") || "{}");
async function __psPost(route, body) {
    const response = await fetch(process.env.PILOTSWARM_WORKFLOW_ENDPOINT + route, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + process.env.PILOTSWARM_WORKFLOW_TOKEN },
        body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error);
    return payload.result;
}
async function callTool(name, args = {}) { return __psPost("/tool", { name, arguments: args }); }
async function setResult(outcome, output = null) { await __psPost("/result", { outcome, output }); }
`;

const PYTHON_PRELUDE = `import json as __ps_json, os as __ps_os, sys as __ps_sys, urllib.request as __ps_request
context = __ps_json.loads(__ps_sys.stdin.read() or "{}")
__ps_opener = __ps_request.build_opener(__ps_request.ProxyHandler({}))
def __ps_post(route, body):
    request = __ps_request.Request(
        __ps_os.environ["PILOTSWARM_WORKFLOW_ENDPOINT"] + route,
        data=__ps_json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": "Bearer " + __ps_os.environ["PILOTSWARM_WORKFLOW_TOKEN"]},
        method="POST",
    )
    with __ps_opener.open(request) as response:
        payload = __ps_json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error"))
    return payload.get("result")
def call_tool(name, arguments=None):
    return __ps_post("/tool", {"name": name, "arguments": arguments or {}})
def set_result(outcome, output=None):
    __ps_post("/result", {"outcome": outcome, "output": output})
`;

const POWERSHELL_PRELUDE = `$ErrorActionPreference = 'Stop'
$__psRaw = [Console]::In.ReadToEnd()
$context = if ($__psRaw) { $__psRaw | ConvertFrom-Json } else { $null }
function __PsPost([string]$Route, $Body) {
    $payload = Invoke-RestMethod -Method Post -Uri ($env:PILOTSWARM_WORKFLOW_ENDPOINT + $Route) -NoProxy \`
        -Headers @{ Authorization = "Bearer $env:PILOTSWARM_WORKFLOW_TOKEN" } -ContentType 'application/json' \`
        -Body ($Body | ConvertTo-Json -Depth 32 -Compress)
    if (-not $payload.ok) { throw $payload.error }
    return $payload.result
}
function Invoke-PilotSwarmTool([string]$Name, $Arguments = @{}) { __PsPost '/tool' @{ name = $Name; arguments = $Arguments } }
function Set-PilotSwarmResult([string]$Outcome, $Output = $null) { [void](__PsPost '/result' @{ outcome = $Outcome; output = $Output }) }
`;

const RUNTIME_FILES: Record<ScriptRuntime, { file: string; prelude: string; args: (file: string) => string[] }> = {
    node: { file: "script.mjs", prelude: NODE_PRELUDE, args: (file) => [file] },
    python: { file: "script.py", prelude: PYTHON_PRELUDE, args: (file) => ["-u", file] },
    powershell: {
        file: "script.ps1",
        prelude: POWERSHELL_PRELUDE,
        args: (file) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", file],
    },
};

function defaultExecutable(runtime: ScriptRuntime): string {
    if (runtime === "node") return process.execPath;
    if (runtime === "python") return process.platform === "win32" ? "python" : "python3";
    return "pwsh";
}

class StreamTail {
    private chunks: Buffer[] = [];
    private size = 0;
    push(chunk: Buffer): void {
        this.chunks.push(chunk);
        this.size += chunk.length;
        while (this.size > STREAM_TAIL_BYTES && this.chunks.length > 1) {
            this.size -= this.chunks.shift()!.length;
        }
    }
    text(): string {
        const all = Buffer.concat(this.chunks);
        return all.subarray(Math.max(0, all.length - STREAM_TAIL_BYTES)).toString("utf8");
    }
}

function toJsonSafe(value: unknown): unknown {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
}

function boundedOutput(nodeId: string, output: unknown): unknown {
    const safe = toJsonSafe(output);
    const bytes = Buffer.byteLength(JSON.stringify(safe), "utf8");
    if (bytes > SCRIPT_NODE_MAX_OUTPUT_BYTES) {
        throw new WorkflowExecutionError(
            `Script state '${nodeId}' produced ${bytes} bytes of output; the limit is ${SCRIPT_NODE_MAX_OUTPUT_BYTES}. `
            + "Store large results as an artifact or fact and pass its key instead.",
        );
    }
    return safe;
}

function lastJsonResultLine(stdout: string): { outcome: string; output: unknown } | null {
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const last = lines.at(-1);
    if (!last || !last.startsWith("{")) return null;
    try {
        const parsed = JSON.parse(last);
        if (parsed && typeof parsed.outcome === "string" && parsed.outcome.trim()) {
            return { outcome: parsed.outcome, output: Object.hasOwn(parsed, "output") ? parsed.output : null };
        }
    } catch { /* not a result line */ }
    return null;
}

function tokensMatch(header: string | undefined, token: string): boolean {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(String(header ?? ""));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readBody(request: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > RPC_MAX_BODY_BYTES) {
                reject(new Error(`request body exceeds ${RPC_MAX_BODY_BYTES} bytes`));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
            catch { reject(new Error("request body is not JSON")); }
        });
        request.on("error", reject);
    });
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Run one script node as a child process on this worker.
 *
 * The script does not inherit the worker's environment (and therefore none
 * of its credentials). It reaches PilotSwarm only through a loopback HTTP
 * endpoint that accepts the per-run bearer token and serves two routes:
 * `POST /tool` runs a tool from the workflow session's tool set, and
 * `POST /result` reports the node's outcome.
 *
 * The outcome is the last reported result; otherwise the last stdout line
 * when it is a JSON object with a string `outcome`; otherwise `success` on
 * exit code 0 (output: trimmed stdout) or `failure` on any other exit, and
 * `timeout` when the node ran past its timeout.
 */
export async function runScriptNode(
    request: RunScriptNodeRequest,
    options: ScriptRunnerOptions = {},
): Promise<RunScriptNodeResult> {
    const { node } = request;
    const runtime = RUNTIME_FILES[node.runtime];
    if (!runtime) throw new WorkflowExecutionError(`Script state '${node.id}' uses unsupported runtime '${node.runtime}'.`);
    const executable = options.executables?.[node.runtime] ?? defaultExecutable(node.runtime);
    const startedAt = Date.now();
    const token = randomBytes(32).toString("hex");
    const toolCalls: ScriptToolCallRecord[] = [];
    let reported: { outcome: string; output: unknown } | null = null;

    const server = http.createServer(async (req, res) => {
        const reply = (status: number, body: unknown) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (req.method !== "POST" || !tokensMatch(req.headers.authorization, token)) {
            reply(403, { ok: false, error: "forbidden" });
            return;
        }
        let body: any;
        try { body = await readBody(req); }
        catch (error) { reply(400, { ok: false, error: errorText(error) }); return; }

        if (req.url === "/result") {
            if (typeof body?.outcome !== "string" || !body.outcome.trim()) {
                reply(400, { ok: false, error: "outcome must be a non-empty string" });
                return;
            }
            reported = { outcome: body.outcome, output: Object.hasOwn(body, "output") ? body.output : null };
            reply(200, { ok: true, result: null });
            return;
        }
        if (req.url === "/tool") {
            const name = typeof body?.name === "string" ? body.name.trim() : "";
            if (!name) { reply(400, { ok: false, error: "name is required" }); return; }
            if (toolCalls.length >= SCRIPT_NODE_MAX_TOOL_CALLS) {
                reply(429, { ok: false, error: `a node may make at most ${SCRIPT_NODE_MAX_TOOL_CALLS} tool calls` });
                return;
            }
            const args = body?.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
                ? body.arguments as Record<string, unknown>
                : {};
            const callStarted = Date.now();
            try {
                const result = await request.callTool({ name, arguments: args });
                toolCalls.push({ name, ok: true, durationMs: Date.now() - callStarted });
                reply(200, { ok: true, result: toJsonSafe(result) });
            } catch (error) {
                toolCalls.push({ name, ok: false, durationMs: Date.now() - callStarted, error: errorText(error) });
                reply(200, { ok: false, error: errorText(error) });
            }
            return;
        }
        reply(404, { ok: false, error: "unknown route" });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-script-"));

    try {
        const scriptPath = path.join(workDir, runtime.file);
        fs.writeFileSync(scriptPath, `${runtime.prelude}\n${node.source}\n`, { mode: 0o600 });

        const env: Record<string, string> = {};
        for (const key of INHERITED_ENV) {
            if (process.env[key] !== undefined) env[key] = process.env[key]!;
        }
        Object.assign(env, {
            HOME: workDir,
            USERPROFILE: workDir,
            TMPDIR: workDir,
            TEMP: workDir,
            TMP: workDir,
            NO_COLOR: "1",
            PYTHONUNBUFFERED: "1",
            PYTHONDONTWRITEBYTECODE: "1",
            PILOTSWARM_WORKFLOW_ENDPOINT: `http://127.0.0.1:${port}`,
            PILOTSWARM_WORKFLOW_TOKEN: token,
            PILOTSWARM_WORKFLOW_SESSION_ID: request.sessionId,
            PILOTSWARM_WORKFLOW_NODE_ID: node.id,
        });

        const stdout = new StreamTail();
        const stderr = new StreamTail();
        let timedOut = false;
        let cancelled = false;

        const exitCode = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(executable, runtime.args(scriptPath), {
                cwd: workDir,
                env,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
            const stop = () => { if (!killProcessTree(child.pid)) child.kill("SIGKILL"); };
            const timer = setTimeout(() => {
                timedOut = true;
                stop();
            }, node.timeoutSeconds * 1000);
            const cancelWatch = request.isCancelled
                ? setInterval(() => {
                    if (!cancelled && request.isCancelled!()) {
                        cancelled = true;
                        stop();
                    }
                }, CANCEL_POLL_MS)
                : null;
            const settle = () => {
                clearTimeout(timer);
                if (cancelWatch) clearInterval(cancelWatch);
            };
            child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
            child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
            child.on("error", (error: NodeJS.ErrnoException) => {
                settle();
                reject(error.code === "ENOENT"
                    ? new WorkflowExecutionError(
                        `Script state '${node.id}' needs the ${node.runtime} runtime, but '${executable}' is not installed on this worker.`,
                    )
                    : error);
            });
            child.on("close", (code) => {
                settle();
                resolve(code);
            });
            child.stdin.on("error", () => { /* the script may exit without reading its context */ });
            child.stdin.end(JSON.stringify({
                sessionId: request.sessionId,
                workflow: request.workflowName,
                node: node.id,
                step: request.step,
                inputs: request.inputs,
                input: request.priorOutput ?? null,
            }));
        });

        const stdoutTail = stdout.text();
        const stderrTail = stderr.text();
        const common = {
            exitCode,
            durationMs: Date.now() - startedAt,
            stdoutTail,
            stderrTail,
            toolCalls,
        };
        if (cancelled) {
            return { ...common, outcome: "cancelled", output: null, resultSource: "cancelled" };
        }
        if (timedOut) {
            return { ...common, outcome: "timeout", output: { timeoutSeconds: node.timeoutSeconds }, resultSource: "timeout" };
        }
        const finalReport = reported as { outcome: string; output: unknown } | null;
        if (finalReport) {
            return { ...common, outcome: finalReport.outcome, output: boundedOutput(node.id, finalReport.output), resultSource: "reported" };
        }
        const fromStdout = lastJsonResultLine(stdoutTail);
        if (fromStdout) {
            return { ...common, outcome: fromStdout.outcome, output: boundedOutput(node.id, fromStdout.output), resultSource: "stdout" };
        }
        if (exitCode === 0) {
            const text = stdoutTail.trim();
            return { ...common, outcome: "success", output: text ? text : null, resultSource: "exit" };
        }
        return {
            ...common,
            outcome: "failure",
            output: { exitCode, stderr: stderrTail.trim().slice(-4_096) },
            resultSource: "exit",
        };
    } finally {
        server.close();
        server.closeAllConnections?.();
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}
