import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { killProcessGroup, killProcessTree } from "../process-tree.js";
import { assertJsonValue, WorkflowJsonError } from "./json.js";

/** The script runtimes the runner knows. A Workflow's script state runs on node (guarded). */
export type ScriptRuntime = "node" | "python" | "powershell";

/** The script state the runner runs: its id, runtime, source, timeout and the outcomes it may report. */
export interface WorkflowScriptState {
    id: string;
    type: "script";
    runtime: ScriptRuntime;
    source: string;
    timeoutSeconds: number;
    /** The outcomes this state may return, in declaration order. */
    outcomes: string[];
    /** Outcome -> next state id. */
    next: Record<string, string>;
}

/** A tool call a script makes. */
export interface ScriptToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export class WorkflowExecutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkflowExecutionError";
    }
}

/** Largest JSON a node may hand to the next node (it is stored in durable history). */
export const SCRIPT_NODE_MAX_OUTPUT_BYTES = 256 * 1024;
/** Most tool calls one node execution may make. */
export const SCRIPT_NODE_MAX_TOOL_CALLS = 500;
const RPC_MAX_BODY_BYTES = 1024 * 1024;
const STREAM_TAIL_BYTES = 16 * 1024;

/** Environment variables a script inherits from the worker. Everything else is dropped. */
const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"];

/**
 * "invalid": a strict-JSON script reported a result that is not plain JSON
 * (through setResult, the endpoint or its final stdout line). "not_started":
 * the caller's entry boundary refused to start the script.
 */
export type ScriptResultSource = "reported" | "stdout" | "exit" | "timeout" | "cancelled" | "invalid" | "not_started";

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
    /** New admissions opt in; historical workflows keep the original runner. */
    guardedNode?: boolean;
    /** Stop brokered work when the script is interrupted. */
    cancelTools?: () => Promise<void>;
    /** The JSON the script reads as `context`; absent: the legacy context built from the fields above. */
    context?: Record<string, unknown>;
    /**
     * Workflow: results and tool arguments must be plain JSON. setResult
     * and callTool encode their value from one read of its own data
     * properties and refuse NaN, Infinity, undefined, functions, symbols,
     * accessors, holes, extra array properties and non-plain objects; no
     * toJSON hook runs. The endpoint re-checks parsed bodies (1e400 parses to
     * Infinity) and a final stdout result line is checked the same way. A
     * result that fails these checks is reported as resultSource "invalid";
     * the result channels and their precedence are the legacy runner's.
     */
    strictJson?: boolean;
    /**
     * Workflow entry boundary. When set, the runner calls it with `start`,
     * which starts the script process with the given context (its stdin).
     * The caller calls `start` at most once, synchronously, while it holds
     * the locks that order this entry against a deletion or cancellation, and
     * resolves whether it did. Without it, the script starts at once.
     */
    enter?: (start: (context: Record<string, unknown>) => void) => Promise<boolean>;
}

export interface RunScriptNodeResult {
    outcome: string;
    output: unknown;
    resultSource: ScriptResultSource;
    exitCode: number | null;
    durationMs: number;
    stdoutTail: string;
    stderrTail: string;
    /** The script wrote more stderr than is kept, so stderrTail lost its front (it may begin inside a line). Absent: kept whole. */
    stderrCut?: boolean;
    toolCalls: ScriptToolCallRecord[];
    /** Why the reported result is not plain JSON (resultSource "invalid"). */
    problem?: string;
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

/**
 * Workflow prelude. setResult and callTool encode a value in one pass over
 * its own data properties, reading each property once, so the text sent is
 * exactly the value that was checked: no getter, Proxy trap or toJSON hook
 * can change it between the check and the encoding. The intrinsics are
 * captured before the script runs. A result that cannot be encoded is still
 * reported (as invalid), so the node fails with invalid_output, and the
 * script then sees the error.
 */
const NODE_STRICT_PRELUDE = `import { readFileSync as __psReadFileSync } from "node:fs";
import { createRequire as __psCreateRequire } from "node:module";
const require = __psCreateRequire(import.meta.url);
const context = JSON.parse(__psReadFileSync(0, "utf8") || "{}");
const __psStringify = JSON.stringify;
const __psOwnKeys = Reflect.ownKeys;
const __psOwnProperty = Reflect.getOwnPropertyDescriptor;
const __psPrototypeOf = Reflect.getPrototypeOf;
const __psApply = Reflect.apply;
const __psHasOwn = Object.hasOwn;
const __psIsArray = Array.isArray;
const __psIsFinite = Number.isFinite;
const __psCharCodeAt = String.prototype.charCodeAt;
const __psString = String;
const __psObjectPrototype = Object.prototype;
const __psArrayPrototype = Array.prototype;
const __psFetch = globalThis.fetch;
const __psEndpoint = process.env.PILOTSWARM_WORKFLOW_ENDPOINT;
const __psToken = process.env.PILOTSWARM_WORKFLOW_TOKEN;
function __psIsIndex(key, length) {
    if (typeof key !== "string" || key.length === 0 || key.length > 10) return false;
    if (key.length > 1 && __psApply(__psCharCodeAt, key, [0]) === 48) return false;
    let value = 0;
    for (let position = 0; position < key.length; position += 1) {
        const code = __psApply(__psCharCodeAt, key, [position]);
        if (code < 48 || code > 57) return false;
        value = value * 10 + (code - 48);
    }
    return value < length;
}
function __psDataValue(property, path) {
    if (!property) throw new TypeError(path + ": the property changed while it was read");
    if (__psHasOwn(property, "get") || __psHasOwn(property, "set") || !__psHasOwn(property, "value")) {
        throw new TypeError(path + ": accessors are not JSON");
    }
    return property.value;
}
function __psEncode(value, path, depth) {
    if (depth > 64) throw new TypeError(path + ": nesting exceeds 64 levels");
    if (value === null) return "null";
    const type = typeof value;
    if (type === "boolean") return value ? "true" : "false";
    if (type === "string") return __psStringify(value);
    if (type === "number") {
        if (!__psIsFinite(value)) throw new TypeError(path + ": numbers must be finite (got " + __psString(value) + ")");
        return __psStringify(value);
    }
    if (type !== "object") throw new TypeError(path + ": " + (value === undefined ? "undefined" : type) + " is not a JSON value");
    const keys = __psOwnKeys(value);
    if (__psIsArray(value)) {
        if (__psPrototypeOf(value) !== __psArrayPrototype) throw new TypeError(path + ": only plain arrays are JSON");
        const length = __psDataValue(__psOwnProperty(value, "length"), path + ".length");
        if (typeof length !== "number" || !(length >= 0)) throw new TypeError(path + ": array length is not plain data");
        let elements = 0;
        for (let position = 0; position < keys.length; position += 1) {
            const key = keys[position];
            if (key === "length") continue;
            if (!__psIsIndex(key, length)) {
                throw new TypeError(path + ": an array may hold only its elements (found " + __psString(key) + ")");
            }
            elements += 1;
        }
        if (elements !== length) throw new TypeError(path + ": sparse arrays are not JSON");
        let text = "[";
        for (let index = 0; index < length; index += 1) {
            const itemPath = path + "[" + index + "]";
            const item = __psDataValue(__psOwnProperty(value, __psString(index)), itemPath);
            text += (index === 0 ? "" : ",") + __psEncode(item, itemPath, depth + 1);
        }
        return text + "]";
    }
    const prototype = __psPrototypeOf(value);
    if (prototype !== __psObjectPrototype && prototype !== null) {
        // The class name is read as a data property only, so no getter of the script runs here.
        const constructor = __psOwnProperty(prototype, "constructor");
        const named = constructor && typeof constructor.value === "function" ? __psOwnProperty(constructor.value, "name") : undefined;
        const name = named && __psHasOwn(named, "value") && typeof named.value === "string" && named.value ? named.value : "object";
        throw new TypeError(path + ": only plain objects are JSON (got " + name + ")");
    }
    let text = "{";
    let first = true;
    for (let position = 0; position < keys.length; position += 1) {
        const key = keys[position];
        if (typeof key === "symbol") throw new TypeError(path + ": symbol keys are not JSON");
        const keyPath = path + "." + key;
        const property = __psOwnProperty(value, key);
        const item = __psDataValue(property, keyPath);
        if (!property.enumerable) throw new TypeError(keyPath + ": non-enumerable properties are not JSON");
        text += (first ? "" : ",") + __psStringify(key) + ":" + __psEncode(item, keyPath, depth + 1);
        first = false;
    }
    return text + "}";
}
async function __psPost(route, body) {
    const response = await __psFetch(__psEndpoint + route, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + __psToken },
        body,
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error);
    return payload.result;
}
async function callTool(name, args = {}) {
    if (typeof name !== "string") throw new TypeError("callTool needs a tool name string");
    if (args === null || typeof args !== "object" || __psIsArray(args)) throw new TypeError("arguments must be a JSON object");
    return __psPost("/tool", '{"name":' + __psStringify(name) + ',"arguments":' + __psEncode(args, "arguments", 0) + "}");
}
function __psProblem(error) {
    // A script's trap or getter may throw anything, even an empty message;
    // the refusal it causes must still be reported as one.
    let text = "";
    try { text = error instanceof Error ? __psString(error.message) : __psString(error); }
    catch { text = ""; }
    return text || "the value cannot be encoded as plain JSON";
}
async function setResult(outcome, output = null) {
    let body;
    try {
        if (typeof outcome !== "string" || outcome.length === 0) throw new TypeError("setResult needs a non-empty outcome string");
        body = '{"outcome":' + __psStringify(outcome) + ',"output":' + __psEncode(output, "output", 0) + "}";
    } catch (error) {
        const problem = __psProblem(error);
        const reported = typeof outcome === "string" ? outcome : "";
        return __psPost("/result", '{"outcome":' + __psStringify(reported) + ',"invalid":' + __psStringify(problem) + "}");
    }
    await __psPost("/result", body);
}
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

/** The SDK's `engines.node` range; a guarded Node script runs only on a worker Node inside it. */
export const WORKFLOW_NODE_ENGINES = "^24.22.1 || >=26.12.1";

/**
 * Whether `version` (a `process.versions.node` string such as "24.22.1") is in
 * {@link WORKFLOW_NODE_ENGINES}. Stage 2.5 (PR 235 1c5b1530): the permission
 * flags a guarded script runs with behave as documented only in that range.
 */
export function workflowNodeVersionSupported(version: string): boolean {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    if (major === 24) return minor > 22 || (minor === 22 && patch >= 1);
    if (major === 26) return minor > 12 || (minor === 12 && patch >= 1);
    return major > 26;
}

function defaultExecutable(runtime: ScriptRuntime): string {
    if (runtime === "node") return process.execPath;
    if (runtime === "python") return process.platform === "win32" ? "python" : "python3";
    return "pwsh";
}

class StreamTail {
    private chunks: Buffer[] = [];
    private size = 0;
    private total = 0;
    push(chunk: Buffer): void {
        this.chunks.push(chunk);
        this.size += chunk.length;
        this.total += chunk.length;
        while (this.size > STREAM_TAIL_BYTES && this.chunks.length > 1) {
            this.size -= this.chunks.shift()!.length;
        }
    }
    text(): string {
        const all = Buffer.concat(this.chunks);
        return all.subarray(Math.max(0, all.length - STREAM_TAIL_BYTES)).toString("utf8");
    }
    /** Whether more was written than text() keeps, so its text lost its front. */
    get cut(): boolean {
        return this.total > STREAM_TAIL_BYTES;
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

/** Why a parsed request value is not plain JSON (e.g. 1e400 parsed to Infinity), or null. */
function strictJsonProblem(value: unknown, path: string): string | null {
    try {
        assertJsonValue(value, path);
        return null;
    } catch (error) {
        if (error instanceof WorkflowJsonError) return error.message;
        throw error;
    }
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
    if (request.guardedNode && (node.runtime !== "node" || executable !== process.execPath)) {
        throw new WorkflowExecutionError("Guarded workflows require the worker's supported Node runtime.");
    }
    if (request.strictJson && node.runtime !== "node") {
        throw new WorkflowExecutionError("Strict-JSON workflow scripts run on the Node runtime only.");
    }
    const prelude = request.strictJson ? NODE_STRICT_PRELUDE : runtime.prelude;
    if (request.guardedNode && !workflowNodeVersionSupported(process.versions.node)) {
        throw new WorkflowExecutionError(`Script state '${node.id}' did not run: this worker runs Node ${process.versions.node}, `
            + `and a Workflow script runs only on Node ${WORKFLOW_NODE_ENGINES} (the SDK's engines range), `
            + "whose permission model guards its files. Run the worker on a Node in that range.");
    }
    const startedAt = Date.now();
    const token = randomBytes(32).toString("hex");
    const toolCalls: ScriptToolCallRecord[] = [];
    let admittedToolCalls = 0;
    let acceptingToolCalls = true;
    let reported: { outcome: string; output: unknown; invalid?: string } | null = null;

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

        if (req.url === "/result" && request.strictJson) {
            // A refused result is still the script's latest result: the node
            // fails with invalid_output instead of running on without one.
            // The marker's presence refuses the result, whatever its text.
            const outcome = typeof body?.outcome === "string" ? body.outcome : "";
            const marked = body !== null && typeof body === "object" && Object.hasOwn(body, "invalid");
            const problem: string | null = marked
                ? (typeof body.invalid === "string" && body.invalid.trim() ? body.invalid : "the script reported a result it could not encode")
                : !outcome.trim() ? "outcome must be a non-empty string"
                : strictJsonProblem(Object.hasOwn(body, "output") ? body.output : null, "output");
            if (problem !== null) {
                reported = { outcome, output: null, invalid: problem };
                reply(400, { ok: false, error: problem });
                return;
            }
            reported = { outcome, output: Object.hasOwn(body, "output") ? body.output : null };
            reply(200, { ok: true, result: null });
            return;
        }
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
            if (!acceptingToolCalls) { reply(409, { ok: false, error: "Workflow state is stopping" }); return; }
            const name = typeof body?.name === "string" ? body.name.trim() : "";
            if (!name) { reply(400, { ok: false, error: "name is required" }); return; }
            if (admittedToolCalls >= SCRIPT_NODE_MAX_TOOL_CALLS) {
                reply(429, { ok: false, error: `a node may make at most ${SCRIPT_NODE_MAX_TOOL_CALLS} tool calls` });
                return;
            }
            const args = body?.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
                ? body.arguments as Record<string, unknown>
                : {};
            const rawArguments = body?.arguments === undefined ? {} : body.arguments;
            const argumentsProblem = !request.strictJson ? null
                : rawArguments === null || typeof rawArguments !== "object" || Array.isArray(rawArguments) ? "arguments must be a JSON object"
                    : strictJsonProblem(rawArguments, "arguments");
            if (argumentsProblem) {
                reply(400, { ok: false, error: argumentsProblem });
                return;
            }
            const callStarted = Date.now();
            admittedToolCalls++;
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
        fs.writeFileSync(scriptPath, `${prelude}\n${node.source}\n`, { mode: 0o600 });

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
        let toolCancellation: Promise<void> | undefined;
        const launch: { exited: Promise<number | null> | null; stop: (() => void) | null } = { exited: null, stop: null };

        // Starts the script process. Synchronous: an entry boundary calls it
        // while it holds the locks that order the start.
        const start = (context: Record<string, unknown>): void => {
            if (launch.exited) throw new WorkflowExecutionError(`Script state '${node.id}' was started twice.`);
            launch.exited = new Promise<number | null>((resolve, reject) => {
                const args = request.guardedNode
                    ? ["--permission", `--allow-fs-read=${workDir}`, `--allow-fs-write=${workDir}`, scriptPath]
                    : runtime.args(scriptPath);
                // Stage 2.4 (PR 235 6e2a1fec): on POSIX the script leads its own process group, so stopping it, or its end,
                // also ends what it started that left its process tree (a daemon reparented to init).
                const groupLeader = process.platform !== "win32";
                const child = spawn(executable, args, {
                    cwd: workDir,
                    env,
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true,
                    detached: groupLeader,
                });
                const stop = () => {
                    acceptingToolCalls = false;
                    const tree = killProcessTree(child.pid);
                    const group = groupLeader && killProcessGroup(child.pid);
                    if (!tree && !group) child.kill("SIGKILL");
                    if (request.cancelTools && !toolCancellation) {
                        toolCancellation = request.cancelTools();
                        // Awaited below; observe rejection now to avoid an unhandled rejection.
                        void toolCancellation.catch(() => undefined);
                    }
                };
                launch.stop = stop;
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
                // When the script's own process ends, what it left running in its group ends with it: a background
                // process holding its output open would otherwise keep the step from finishing until its timeout.
                child.on("exit", () => {
                    if (groupLeader) killProcessGroup(child.pid);
                });
                child.on("close", (code) => {
                    settle();
                    resolve(code);
                });
                child.stdin.on("error", () => { /* the script may exit without reading its context */ });
                child.stdin.end(JSON.stringify(context));
            });
        };

        if (request.enter) {
            let entered: boolean;
            try {
                entered = await request.enter(start);
            } catch (error) {
                // The entry failed after the script started (its commit did not
                // complete): stop the script before reporting the failure.
                if (launch.exited) {
                    launch.stop?.();
                    await Promise.allSettled([launch.exited]);
                }
                throw error;
            }
            if (entered !== Boolean(launch.exited)) {
                if (launch.exited) {
                    launch.stop?.();
                    await Promise.allSettled([launch.exited]);
                }
                throw new WorkflowExecutionError(`Script state '${node.id}': the entry boundary ${entered ? "did not start the script" : "started the script but refused it"}.`);
            }
            if (!entered) {
                return {
                    outcome: "", output: null, resultSource: "not_started", exitCode: null, durationMs: Date.now() - startedAt,
                    stdoutTail: "", stderrTail: "", toolCalls,
                };
            }
        } else {
            start(request.context ?? {
                sessionId: request.sessionId,
                workflow: request.workflowName,
                node: node.id,
                step: request.step,
                inputs: request.inputs,
                input: request.priorOutput ?? null,
            });
        }
        if (!launch.exited) throw new WorkflowExecutionError(`Script state '${node.id}' did not start.`);
        const exitCode = await launch.exited;
        acceptingToolCalls = false;
        if (toolCancellation) {
            try { await toolCancellation; }
            catch (error) {
                throw new WorkflowExecutionError(
                    `Script state '${node.id}' ${cancelled ? "was cancelled" : timedOut ? "timed out" : "stopped"}; tool cleanup failed: ${errorText(error)}`,
                );
            }
        }

        const stdoutTail = stdout.text();
        const stderrTail = stderr.text();
        const common = {
            exitCode,
            durationMs: Date.now() - startedAt,
            stdoutTail,
            stderrTail,
            ...(stderr.cut ? { stderrCut: true } : {}),
            toolCalls,
        };
        if (cancelled) {
            return { ...common, outcome: "cancelled", output: null, resultSource: "cancelled" };
        }
        if (timedOut) {
            return { ...common, outcome: "timeout", output: { timeoutSeconds: node.timeoutSeconds }, resultSource: "timeout" };
        }
        const finalReport = reported as { outcome: string; output: unknown; invalid?: string } | null;
        if (request.strictJson) {
            // The legacy channels and precedence, with every value checked:
            // the last setResult, else a final stdout result line, else the exit code.
            if (finalReport?.invalid !== undefined) {
                return { ...common, outcome: finalReport.outcome, output: null, resultSource: "invalid", problem: finalReport.invalid };
            }
            if (finalReport) return { ...common, outcome: finalReport.outcome, output: finalReport.output, resultSource: "reported" };
            const line = lastJsonResultLine(stdoutTail);
            if (line) {
                const problem = strictJsonProblem(line.output, "output");
                if (problem) return { ...common, outcome: line.outcome, output: null, resultSource: "invalid", problem };
                return { ...common, outcome: line.outcome, output: line.output, resultSource: "stdout" };
            }
        } else {
            if (finalReport) {
                return { ...common, outcome: finalReport.outcome, output: boundedOutput(node.id, finalReport.output), resultSource: "reported" };
            }
            const fromStdout = lastJsonResultLine(stdoutTail);
            if (fromStdout) {
                return { ...common, outcome: fromStdout.outcome, output: boundedOutput(node.id, fromStdout.output), resultSource: "stdout" };
            }
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
