/**
 * The worker's end of the side channel to a compute host
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * One of these exists per host of a session tree, beside the runtime
 * connection and proved by the same handshake. It does two jobs.
 *
 * **It sends the copies.** The folders a session is authorized to see are
 * walked here (compute-assets.ts), and only the files the host has never
 * been sent cross; everything is named by its own digest, so a folder
 * that has not changed costs a question and an answer.
 *
 * **It forwards MCP traffic** for the servers the deployment configured,
 * which stay on the trusted side and are started here, exactly as they
 * are for a session that runs on the worker: same command, same
 * environment, same headers, same credentials. The host asks for one by
 * ticket; nothing else about the server ever crosses.
 *
 * What this will not do:
 *
 * - **Take the host's word for which server.** A ticket is minted here,
 *   for one session and one server, and is forgotten when the session
 *   stops using it. A ticket this worker did not mint, or minted for a
 *   session that has let go, reaches nothing.
 * - **Lend the worker's identity.** The caller's own credentials go
 *   through as they arrived; the worker adds none of its own. What it
 *   does add is a statement of which session is calling and who owns it,
 *   so the server can make its own checks and keep its own record.
 * - **Read what it carries.** The bytes of an MCP conversation are
 *   forwarded, never parsed, so whatever the runtime and the server
 *   support between them keeps working. Only HTTP itself is understood,
 *   because an HTTP request has to be made to be forwarded at all.
 * - **Carry without limit.** A frame is bounded by the channel; one
 *   forwarded conversation has a byte ceiling, and one HTTP call has a
 *   deadline.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { computeCopyDigests, computeCopyManifest, type ComputeCopyPlan } from "./compute-assets.js";
import { ComputeChannel, type ComputeChannelStream } from "./compute-channel.js";
import type { RemoteMcpHostFacts } from "./compute-mcp.js";

/** The most bytes one forwarded conversation carries in one direction. */
export const COMPUTE_FORWARD_MAX_BYTES = 64 * 1024 * 1024;
/** How long one forwarded HTTP call may take, before a server's own setting. */
export const COMPUTE_FORWARD_TIMEOUT_MS = 120_000;
/** How long the host has to answer a question about the copies. */
export const COMPUTE_CONTROL_REQUEST_TIMEOUT_MS = 60_000;

/** Headers that belong to one hop of a connection and are never forwarded. */
const HOP_BY_HOP = new Set([
    "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length", "expect",
]);

/** Who is calling, as the worker vouches for it. Never a credential. */
export interface ComputeCallerStatement {
    sessionId: string;
    rootSessionId: string;
    ownerProvider: string;
    ownerSubject: string;
    ownerEmail: string;
    computeTarget: string;
}

/** One server a session may reach through this link. */
interface ForwardGrant {
    sessionId: string;
    server: string;
    /** The deployment's configuration, as the worker resolved it today. */
    config: any;
    caller: ComputeCallerStatement;
}

function vouchedEnv(caller: ComputeCallerStatement): Record<string, string> {
    return {
        PILOTSWARM_CALLER_SESSION: caller.sessionId,
        PILOTSWARM_CALLER_ROOT_SESSION: caller.rootSessionId,
        PILOTSWARM_CALLER_OWNER_PROVIDER: caller.ownerProvider,
        PILOTSWARM_CALLER_OWNER_SUBJECT: caller.ownerSubject,
        PILOTSWARM_CALLER_OWNER_EMAIL: caller.ownerEmail,
        PILOTSWARM_CALLER_COMPUTE_TARGET: caller.computeTarget,
        PILOTSWARM_CALLER_RUNS_REMOTELY: "1",
    };
}

function vouchedHeaders(caller: ComputeCallerStatement): Record<string, string> {
    return {
        "pilotswarm-caller-session": caller.sessionId,
        "pilotswarm-caller-root-session": caller.rootSessionId,
        "pilotswarm-caller-owner-provider": caller.ownerProvider,
        "pilotswarm-caller-owner-subject": caller.ownerSubject,
        "pilotswarm-caller-owner-email": caller.ownerEmail,
        "pilotswarm-caller-compute-target": caller.computeTarget,
        "pilotswarm-caller-runs-remotely": "1",
    };
}

/**
 * Join what the runtime asked for onto the address the deployment
 * configured. The runtime was given a local address of its own, so
 * everything after the ticket is its own, and the configured address
 * keeps whatever path it had.
 */
export function forwardUrl(configured: string, rest: string): string {
    if (!rest || rest === "/") return configured;
    const cut = configured.indexOf("?");
    const base = cut < 0 ? configured : configured.slice(0, cut);
    const query = cut < 0 ? "" : configured.slice(cut);
    const restCut = rest.indexOf("?");
    const restPath = restCut < 0 ? rest : rest.slice(0, restCut);
    const restQuery = restCut < 0 ? "" : rest.slice(restCut);
    const joined = base.endsWith("/") && restPath.startsWith("/") ? base.slice(0, -1) + restPath : base + restPath;
    return joined + (restQuery || query);
}

/**
 * The headers one forwarded call is made with.
 *
 * The deployment's configured headers go on first, because that is how
 * the server is configured today. The caller's own go on next and win,
 * so a token the runtime holds reaches the server exactly as it was sent
 * and the worker never swaps in one of its own. The worker's statement of
 * who is calling goes on last, so nothing from the host can be passed off
 * as it.
 */
export function forwardHeaders(
    configured: Record<string, string> | undefined,
    fromCaller: Record<string, string | string[] | undefined>,
    caller: ComputeCallerStatement,
): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(configured ?? {})) {
        if (typeof value === "string") headers[key.toLowerCase()] = value;
    }
    for (const [key, value] of Object.entries(fromCaller ?? {})) {
        const name = key.toLowerCase();
        if (HOP_BY_HOP.has(name)) continue;
        if (value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    return { ...headers, ...vouchedHeaders(caller) };
}

export interface ComputeControlLinkOptions {
    /** How long one forwarded conversation may carry in one direction. */
    maxForwardBytes?: number;
    /** How long one forwarded HTTP call may take. */
    forwardTimeoutMs?: number;
    /** Told when something could not be forwarded; recorded in the session's events. */
    onRefusal?: (refusal: { ticket: string; reason: string }) => void;
}

/**
 * The link itself. Made once per host of a session tree and kept for as
 * long as the worker holds that host.
 */
export class ComputeControlLink {
    private readonly channel: ComputeChannel;
    private readonly grants = new Map<string, ForwardGrant>();
    /** The ticket a session already holds for a server, so it stays the same. */
    private readonly byServer = new Map<string, string>();
    private readonly pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    private readonly children = new Set<ChildProcess>();
    private ready: RemoteMcpHostFacts | null = null;
    private readyWaiters: Array<(facts: RemoteMcpHostFacts) => void> = [];
    private nextRequest = 1;
    private closed = false;
    /** Where each copied folder ended up on the host, by the name the worker gave it. */
    readonly placements: Record<string, string> = {};

    constructor(connection: Duplex, private readonly options: ComputeControlLinkOptions = {}) {
        this.channel = new ComputeChannel(connection, { side: "worker" });
        this.channel.on("notice", (message: Record<string, unknown>) => this.onNotice(message));
        this.channel.on("stream", (stream: ComputeChannelStream) => this.onStream(stream));
        this.channel.on("close", () => this.onClosed());
        this.channel.start();
    }

    get isClosed(): boolean {
        return this.closed || this.channel.isClosed;
    }

    /** What the host said about itself, once it has said it. */
    async hostFacts(timeoutMs = COMPUTE_CONTROL_REQUEST_TIMEOUT_MS): Promise<RemoteMcpHostFacts> {
        if (this.ready) return { ...this.ready, placements: this.placements };
        const facts = await new Promise<RemoteMcpHostFacts>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("the compute host did not say what it offers in time")), timeoutMs);
            this.readyWaiters.push((value) => { clearTimeout(timer); resolve(value); });
            if (this.isClosed) { clearTimeout(timer); reject(new Error("the side channel to the compute host is closed")); }
        });
        return { ...facts, placements: this.placements };
    }

    private onNotice(message: Record<string, unknown>): void {
        if (message.t === "ready") {
            const relay = message.relay as { command?: unknown; args?: unknown } | undefined;
            this.ready = {
                placements: this.placements,
                separator: typeof message.separator === "string" ? message.separator : "/",
                httpBase: typeof message.httpBase === "string" ? message.httpBase : null,
                relay: relay && typeof relay.command === "string"
                    ? { command: relay.command, args: (Array.isArray(relay.args) ? relay.args : []).map((entry) => String(entry)) }
                    : null,
            };
            const waiters = this.readyWaiters;
            this.readyWaiters = [];
            for (const waiter of waiters) waiter(this.ready);
            return;
        }
        const id = String(message.id ?? "");
        const waiting = this.pending.get(id);
        if (!waiting) return;
        this.pending.delete(id);
        if (message.t === "failed") waiting.reject(new Error(String(message.error ?? "the compute host refused")));
        else waiting.resolve(message);
    }

    private onClosed(): void {
        this.closed = true;
        for (const [, waiting] of this.pending) waiting.reject(new Error("the side channel to the compute host closed"));
        this.pending.clear();
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const waiter of waiters) waiter(this.ready ?? { placements: this.placements, relay: null, httpBase: null, separator: "/" });
        for (const child of [...this.children]) this.stopChild(child);
    }

    private async request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
        const id = String(this.nextRequest++);
        const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error("the compute host did not answer in time"));
            }, COMPUTE_CONTROL_REQUEST_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
        });
        await this.channel.notice({ ...message, id });
        return answer;
    }

    /**
     * Send what the host has not got, then ask for the folders to be laid
     * out. Gives back where each one is.
     */
    async copy(plan: ComputeCopyPlan): Promise<Record<string, string>> {
        if (plan.items.length === 0) return {};
        const sources = new Map<string, string>();
        for (const item of plan.items) {
            for (const file of item.files) {
                if (!sources.has(file.digest)) sources.set(file.digest, path.join(item.source, ...file.path.split("/")));
            }
        }
        const answer = await this.request({ t: "have", digests: computeCopyDigests(plan.items) });
        const missing: string[] = (Array.isArray(answer.missing) ? answer.missing : []).map((entry) => String(entry));
        for (const digest of missing) {
            const source = sources.get(digest);
            if (!source) continue;
            await this.sendBlob(digest, fs.readFileSync(source));
        }
        const placed = await this.request({ t: "place", items: computeCopyManifest(plan.items) });
        const placements = (placed.placements ?? {}) as Record<string, unknown>;
        for (const [name, where] of Object.entries(placements)) {
            if (typeof where === "string" && where) this.placements[name] = where;
        }
        return { ...this.placements };
    }

    private async sendBlob(digest: string, body: Buffer): Promise<void> {
        const stream = this.channel.open("blob", { digest });
        const answered = new Promise<void>((resolve, reject) => {
            let said: Record<string, unknown> | null = null;
            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve();
            };
            stream.on("data", (chunk: Buffer) => {
                try { said = JSON.parse(chunk.toString("utf8")); } catch { said = { ok: false, error: "the host's answer was not readable" }; }
            });
            stream.on("end", () => {
                // Settled before the stream is closed: closing it raises
                // the close event, which would otherwise answer first.
                finish(said && said.ok === true ? undefined : new Error(String(said?.error ?? "the compute host did not keep that file")));
                stream.close();
            });
            stream.on("close", (reason?: string) => finish(new Error(reason ?? "the compute host closed the transfer")));
        });
        await stream.write(body);
        await stream.end();
        await answered;
    }

    /**
     * Let one session reach one server through this link.
     *
     * A session keeps the same ticket for the same server for as long as
     * it is on this host: a runtime that is still warm holds the
     * configuration it was given, so a ticket that changed under it would
     * leave it talking to a server the worker no longer recognises. The
     * server's configuration behind the ticket is refreshed every turn.
     */
    mintTicket(grant: ForwardGrant): string {
        const key = `${grant.sessionId}\u0000${grant.server}`;
        const held = this.byServer.get(key);
        if (held) {
            this.grants.set(held, grant);
            return held;
        }
        const ticket = randomBytes(24).toString("hex");
        this.grants.set(ticket, grant);
        this.byServer.set(key, ticket);
        return ticket;
    }

    /** Forget every ticket this session held: it is no longer on this host. */
    forgetSession(sessionId: string): void {
        for (const [ticket, grant] of [...this.grants]) {
            if (grant.sessionId !== sessionId) continue;
            this.grants.delete(ticket);
            this.byServer.delete(`${grant.sessionId}\u0000${grant.server}`);
        }
    }

    /** Test and diagnostic view: how many tickets stand. */
    get ticketCount(): number {
        return this.grants.size;
    }

    close(): void {
        this.closed = true;
        this.channel.close("the worker let this host go");
    }

    private refuse(stream: ComputeChannelStream, ticket: string, reason: string): void {
        this.options.onRefusal?.({ ticket, reason });
        stream.close(reason);
    }

    private onStream(stream: ComputeChannelStream): void {
        const ticket = String(stream.meta.ticket ?? "");
        const grant = this.grants.get(ticket);
        if (!grant) {
            // The host asked for something this worker never offered this
            // session. Nothing is started and nothing is reached.
            this.refuse(stream, ticket, "this worker has no such forwarding ticket");
            return;
        }
        if (stream.kind === "mcp") {
            this.forwardStdio(stream, grant);
            return;
        }
        if (stream.kind === "mcp-http") {
            void this.forwardHttp(stream, grant);
            return;
        }
        this.refuse(stream, ticket, "this worker does not forward streams of that kind");
    }

    private stopChild(child: ChildProcess): void {
        this.children.delete(child);
        try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
        } catch { /* already gone */ }
    }

    /**
     * A server that speaks over its own input and output. It is started
     * here, on the trusted side, with the environment it is configured
     * with today — plus a statement of who is calling, which the worker
     * is the only one able to make.
     */
    private forwardStdio(stream: ComputeChannelStream, grant: ForwardGrant): void {
        const config = grant.config ?? {};
        const limit = this.options.maxForwardBytes ?? COMPUTE_FORWARD_MAX_BYTES;
        let child: ChildProcess;
        try {
            child = spawn(String(config.command), (config.args ?? []).map((entry: unknown) => String(entry)), {
                cwd: typeof config.cwd === "string" ? config.cwd : undefined,
                env: { ...process.env, ...(config.env ?? {}), ...vouchedEnv(grant.caller) },
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                detached: process.platform !== "win32",
            });
        } catch (error) {
            this.refuse(stream, "", `the server "${grant.server}" could not be started: ${String((error as Error)?.message ?? error)}`);
            return;
        }
        this.children.add(child);
        let carried = 0;
        child.stderr?.resume();
        child.stdout?.on("data", (chunk: Buffer) => {
            carried += chunk.length;
            if (carried > limit) {
                this.refuse(stream, "", `the server "${grant.server}" sent more than the ${limit} bytes one forwarded conversation carries`);
                this.stopChild(child);
                return;
            }
            void stream.write(chunk).catch(() => this.stopChild(child));
        });
        child.on("error", () => stream.close(`the server "${grant.server}" could not be started`));
        child.on("exit", () => { this.children.delete(child); stream.close(); });
        let received = 0;
        stream.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > limit) {
                this.refuse(stream, "", `more than the ${limit} bytes one forwarded conversation carries arrived for "${grant.server}"`);
                this.stopChild(child);
                return;
            }
            child.stdin?.write(chunk);
        });
        stream.on("end", () => child.stdin?.end());
        stream.on("close", () => this.stopChild(child));
    }

    /**
     * A server reached over HTTP. The call is made from here, so the
     * address and whatever the deployment configured never leave the
     * worker; what the caller sent travels unchanged.
     */
    private async forwardHttp(stream: ComputeChannelStream, grant: ForwardGrant): Promise<void> {
        const config = grant.config ?? {};
        const limit = this.options.maxForwardBytes ?? COMPUTE_FORWARD_MAX_BYTES;
        const method = String(stream.meta.method ?? "GET").toUpperCase();
        const parts: Buffer[] = [];
        let received = 0;
        let overflowed = false;
        const body = new Promise<Buffer>((resolve) => {
            stream.on("data", (chunk: Buffer) => {
                received += chunk.length;
                if (received > limit) { overflowed = true; return; }
                parts.push(chunk);
            });
            stream.on("end", () => resolve(Buffer.concat(parts)));
            stream.on("close", () => resolve(Buffer.concat(parts)));
        });
        const sent = await body;
        if (overflowed) {
            this.refuse(stream, "", `more than the ${limit} bytes one forwarded call carries arrived for "${grant.server}"`);
            return;
        }
        const controller = new AbortController();
        const timeoutMs = typeof config.timeout === "number" && config.timeout > 0
            ? config.timeout
            : this.options.forwardTimeoutMs ?? COMPUTE_FORWARD_TIMEOUT_MS;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const answer = await fetch(forwardUrl(String(config.url), String(stream.meta.path ?? "")), {
                method,
                headers: forwardHeaders(config.headers, (stream.meta.headers ?? {}) as Record<string, string | string[] | undefined>, grant.caller),
                ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(sent) }),
                redirect: "manual",
                signal: controller.signal,
            });
            const headers: Record<string, string> = {};
            answer.headers.forEach((value, key) => { if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value; });
            await stream.write(Buffer.from(JSON.stringify({ status: answer.status, headers }), "utf8"));
            if (answer.body) {
                let carried = 0;
                for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
                    carried += chunk.byteLength;
                    if (carried > limit) break;
                    await stream.write(Buffer.from(chunk));
                }
            }
            await stream.end();
        } catch (error) {
            const reason = String((error as Error)?.message ?? error);
            this.options.onRefusal?.({ ticket: String(stream.meta.ticket ?? ""), reason: `the server "${grant.server}" could not be reached: ${reason}` });
            stream.close(reason);
        } finally {
            clearTimeout(timer);
        }
    }
}
