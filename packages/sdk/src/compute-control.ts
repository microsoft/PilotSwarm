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
 *   session that has let go, reaches nothing. The whole set a session
 *   holds is reconciled at every turn, so a server the session is no
 *   longer authorized for loses its ticket, and whatever that ticket had
 *   open is ended with it.
 * - **Take the host's word for where.** The address the deployment
 *   configured pins the origin and the path the call may reach. What the
 *   runtime asked for is joined under that path and nowhere else: not
 *   another host, not another path, not through a dot segment or an
 *   encoded one.
 * - **Lend the worker's identity.** The caller's own credentials go
 *   through as they arrived; the worker adds nothing beyond what the
 *   deployment itself configured for that server. What it does add is a
 *   statement of which session is calling and who owns it, so the server
 *   can make its own checks and keep its own record.
 * - **Read what it carries.** The bytes of an MCP conversation are
 *   forwarded, never parsed, so whatever the runtime and the server
 *   support between them keeps working. Only HTTP itself is understood,
 *   because an HTTP request has to be made to be forwarded at all.
 * - **Carry without limit.** A frame is bounded by the channel; one
 *   forwarded conversation has a byte ceiling, and one HTTP call has a
 *   deadline.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { Duplex } from "node:stream";
import { computeCopyDigests, computeCopyManifest, forgetComputeDigest, type ComputeCopyPlan } from "./compute-assets.js";
import { ComputeChannel, type ComputeChannelStream } from "./compute-channel.js";
import type { RemoteMcpHostFacts } from "./compute-mcp.js";

/** The most bytes one forwarded conversation carries in one direction. */
export const COMPUTE_FORWARD_MAX_BYTES = 64 * 1024 * 1024;
/**
 * How long one forwarded HTTP call may wait for the server's answer to
 * begin, before a server's own setting.
 *
 * It bounds the wait for the response headers and then the longest gap
 * between bytes — not the whole conversation. A server that streams for
 * an hour is what a session on the worker gets too; a server that says
 * nothing is not.
 */
export const COMPUTE_FORWARD_TIMEOUT_MS = 120_000;
/** How long the host has to answer a question about the copies. */
export const COMPUTE_CONTROL_REQUEST_TIMEOUT_MS = 60_000;
/** How long the whole of one session's copy may take, acknowledgements and all. */
export const COMPUTE_CONTROL_COPY_TIMEOUT_MS = 180_000;
/** How often the worker proves to the host that this channel is still alive. */
export const COMPUTE_CONTROL_HEARTBEAT_MS = 30_000;
/**
 * The most servers one host may have started for one session at a time,
 * and the most that may be started in a minute.
 *
 * A host asks for these: it opens a stream and the worker starts a
 * process. Without a ceiling a host that is misbehaving can make the
 * worker start processes until the worker has none left.
 */
export const COMPUTE_FORWARD_MAX_LIVE_PROCESSES = 32;
export const COMPUTE_FORWARD_MAX_PROCESS_STARTS_PER_MINUTE = 120;
/** The most bytes all the forwarded calls of one host may hold at once. */
export const COMPUTE_FORWARD_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/** The methods a forwarded call may use. Anything else is refused. */
export const COMPUTE_FORWARD_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Headers that belong to one hop of a connection and are never forwarded. */
const HOP_BY_HOP = new Set([
    "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length", "expect",
]);

/**
 * Headers of an answer that describe bytes the worker no longer has.
 *
 * The call is made here with `fetch`, which decodes a compressed body
 * before handing it over. Passing the original `content-encoding` on with
 * the decoded bytes would tell the runtime to decode plain JSON a second
 * time; `content-length` is already a hop-by-hop header above.
 */
const DECODED_AWAY = new Set(["content-encoding", "content-length"]);

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

/** What a forwarded call may be made against, or why it may not be made. */
export type ForwardDestination = { ok: true; url: string } | { ok: false; reason: string };

/** A path a manifest or a runtime hands over must not smuggle a separator or a step up. */
const ENCODED_PATH_TRICK = /%2[eEfF]|%5[cC]|%25/;

/**
 * Where one forwarded call may go.
 *
 * The deployment configured one address. That address pins both the
 * origin and the path: the call goes to that host, under that path, and
 * nowhere else. What the runtime asked for — everything after the ticket
 * in the local address the host gave it — is joined under the configured
 * path, after it has been checked for the ways a path can be made to
 * mean somewhere else:
 *
 * - it must be empty or begin with a single `/`, so it cannot be read as
 *   an authority (`//elsewhere.invalid/x`) or as a whole address;
 * - it may carry no fragment, no backslash, no `.` or `..` segment, and
 *   no percent-encoded separator or dot, so a normalization at either end
 *   cannot walk it out of the configured path;
 * - after joining, the origin must still be the configured origin and the
 *   path must still be the configured path or inside it.
 *
 * The configured query is kept and the caller's is merged under it: what
 * the deployment set for this server wins, and anything else the runtime
 * sent goes through.
 */
export function forwardDestination(configured: unknown, rest: unknown): ForwardDestination {
    let base: URL;
    try {
        base = new URL(String(configured ?? ""));
    } catch {
        return { ok: false, reason: "this server's configured address is not an address" };
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
        return { ok: false, reason: "this server's configured address is not an HTTP address" };
    }
    if (base.username || base.password) {
        return { ok: false, reason: "this server's configured address carries a user name or password" };
    }
    const asked = typeof rest === "string" ? rest : "";
    if (asked.includes("#")) return { ok: false, reason: "a forwarded call may not name a fragment" };
    if (asked.includes("\\")) return { ok: false, reason: "a forwarded call may not name a backslash" };
    if (asked.includes("\u0000")) return { ok: false, reason: "a forwarded call may not name a null byte" };
    if (asked && !asked.startsWith("/")) return { ok: false, reason: "a forwarded call names a path, which begins with /" };
    if (asked.startsWith("//")) return { ok: false, reason: "a forwarded call may not name another host" };
    const restCut = asked.indexOf("?");
    const restPath = restCut < 0 ? asked : asked.slice(0, restCut);
    const restQuery = restCut < 0 ? "" : asked.slice(restCut + 1);
    if (ENCODED_PATH_TRICK.test(restPath)) {
        return { ok: false, reason: "a forwarded call may not name an encoded separator or dot" };
    }
    if (restPath.split("/").some((part) => part === "." || part === "..")) {
        return { ok: false, reason: "a forwarded call may not step through a path" };
    }
    const basePath = base.pathname || "/";
    const joined = restPath === "" || restPath === "/"
        ? basePath
        : basePath.endsWith("/") ? basePath.slice(0, -1) + restPath : basePath + restPath;
    let destination: URL;
    try {
        destination = new URL(joined, base.origin);
    } catch {
        return { ok: false, reason: "a forwarded call names a path this worker cannot build an address from" };
    }
    if (destination.origin !== base.origin || destination.username || destination.password) {
        return { ok: false, reason: "a forwarded call may not reach a different address than the one configured" };
    }
    const prefix = basePath.endsWith("/") ? basePath : basePath + "/";
    if (destination.pathname !== basePath && !destination.pathname.startsWith(prefix)) {
        return { ok: false, reason: "a forwarded call may not reach outside the path this server was configured with" };
    }
    // The configured query is the deployment's and wins; the rest of what
    // the runtime sent goes through beside it.
    const query = new URLSearchParams(restQuery);
    for (const [key, value] of new URLSearchParams(base.search)) query.set(key, value);
    const search = query.toString();
    destination.search = search ? `?${search}` : "";
    destination.hash = "";
    return { ok: true, url: destination.toString() };
}

/**
 * Join what the runtime asked for onto the address the deployment
 * configured, or throw when it may not be joined at all. `forwardDestination`
 * is the form that answers rather than throws.
 */
export function forwardUrl(configured: string, rest: string): string {
    const destination = forwardDestination(configured, rest);
    if (!destination.ok) throw new Error(destination.reason);
    return destination.url;
}

/**
 * The headers one forwarded call is made with.
 *
 * The caller's own go on first: a token the runtime holds reaches the
 * server exactly as it was sent. The deployment's configured headers go
 * on next and win, because a header the deployment set for this server is
 * the deployment's decision and a caller must not be able to replace it.
 * The worker's statement of who is calling goes on last, so nothing from
 * the host can be passed off as it.
 *
 * Nothing of the worker's own is added: the only values here are the ones
 * the deployment configured for this server and the ones the caller sent.
 */
export function forwardHeaders(
    configured: Record<string, string> | undefined,
    fromCaller: Record<string, string | string[] | undefined>,
    caller: ComputeCallerStatement,
): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(fromCaller ?? {})) {
        const name = key.toLowerCase();
        if (HOP_BY_HOP.has(name)) continue;
        if (value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    for (const [key, value] of Object.entries(configured ?? {})) {
        if (typeof value === "string") headers[key.toLowerCase()] = value;
    }
    return { ...headers, ...vouchedHeaders(caller) };
}

export interface ComputeControlLinkOptions {
    /** How long one forwarded conversation may carry in one direction. */
    maxForwardBytes?: number;
    /** How long one forwarded HTTP call may wait to be answered, and between bytes. */
    forwardTimeoutMs?: number;
    /** The most servers this host may have started at once. */
    maxLiveProcesses?: number;
    /** The most servers this host may have started in the last minute. */
    maxProcessStartsPerMinute?: number;
    /** The most bytes all of this host's forwarded calls may hold at once. */
    maxBufferedBytes?: number;
    /** How often to prove to the host that this channel is alive. 0 turns it off. */
    heartbeatMs?: number;
    /** Told when something could not be forwarded; recorded in the session's events. */
    onRefusal?: (refusal: { ticket: string; reason: string }) => void;
}

/** What one open forwarded conversation holds, so revoking its grant can end it. */
interface ActiveForward {
    sessionId: string;
    server: string;
    stop: () => void;
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
    /** Every forwarded conversation that is still open, by the stream carrying it. */
    private readonly active = new Map<ComputeChannelStream, ActiveForward>();
    /** When each server was started for this host, so starts can be rate-limited. */
    private recentStarts: number[] = [];
    /** How many bytes every forwarded call of this host is holding right now. */
    private bufferedBytes = 0;
    private ready: RemoteMcpHostFacts | null = null;
    private readyWaiters: Array<(facts: RemoteMcpHostFacts) => void> = [];
    private nextRequest = 1;
    private closed = false;
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    /** Where each copied folder ended up on the host, by the name the worker gave it. */
    readonly placements: Record<string, string> = {};

    constructor(connection: Duplex, private readonly options: ComputeControlLinkOptions = {}) {
        this.channel = new ComputeChannel(connection, { side: "worker" });
        this.channel.on("notice", (message: Record<string, unknown>) => this.onNotice(message));
        this.channel.on("stream", (stream: ComputeChannelStream) => this.onStream(stream));
        this.channel.on("close", () => this.onClosed());
        this.channel.start();
        const every = options.heartbeatMs ?? COMPUTE_CONTROL_HEARTBEAT_MS;
        if (every > 0) {
            // Bytes on the channel are what tells the host this worker is
            // still here. A warm session can say nothing for a long time,
            // and a host that cannot tell the difference between quiet and
            // gone would either end too early or never end at all.
            this.heartbeat = setInterval(() => {
                if (this.closed) return;
                void this.channel.notice({ t: "alive" }).catch(() => { /* the channel reports its own end */ });
            }, every);
            this.heartbeat.unref?.();
        }
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
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
        for (const [, waiting] of this.pending) waiting.reject(new Error("the side channel to the compute host closed"));
        this.pending.clear();
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const waiter of waiters) waiter(this.ready ?? { placements: this.placements, relay: null, httpBase: null, separator: "/" });
        for (const entry of [...this.active.values()]) entry.stop();
        this.active.clear();
        for (const child of [...this.children]) this.stopChild(child);
    }

    private async request(message: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
        if (signal?.aborted) throw new Error("the copy to the compute host was given up on");
        const id = String(this.nextRequest++);
        let onAbort: (() => void) | undefined;
        const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error("the compute host did not answer in time"));
            }, COMPUTE_CONTROL_REQUEST_TIMEOUT_MS);
            const settle = { timer, resolve, reject };
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(settle.timer); if (onAbort) signal?.removeEventListener("abort", onAbort); resolve(value); },
                reject: (error) => { clearTimeout(settle.timer); if (onAbort) signal?.removeEventListener("abort", onAbort); reject(error); },
            });
            if (signal) {
                onAbort = () => {
                    const waiting = this.pending.get(id);
                    this.pending.delete(id);
                    waiting?.reject(new Error("the copy to the compute host was given up on"));
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
        try {
            await this.channel.notice({ ...message, id });
        } catch (error) {
            // The question never left. Settle the answer that was already
            // waiting for it and take it out of the map, rather than
            // leaving a promise nobody holds to reject on its own timer.
            const waiting = this.pending.get(id);
            this.pending.delete(id);
            waiting?.reject(error instanceof Error ? error : new Error(String(error)));
            await answer.catch(() => { /* settled above; this is the reject we are about to throw */ });
            throw error;
        }
        return answer;
    }

    /**
     * Send what the host has not got, then ask for the folders to be laid
     * out. Gives back where each one is.
     *
     * The whole operation — the questions, the bytes and the host's
     * acknowledgement of each file — is bounded by one deadline, because
     * a host that takes a file and then says nothing would otherwise hold
     * a turn open for as long as it liked.
     *
     * A digest list and a folder's manifest are both sent in pieces that
     * fit what the channel carries, so the file and byte limits a
     * deployment sets are the only thing that decides how large a copy
     * may be.
     */
    async copy(plan: ComputeCopyPlan, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, string>> {
        if (plan.items.length === 0) return {};
        const controller = new AbortController();
        const give = (reason: string) => { if (!controller.signal.aborted) controller.abort(new Error(reason)); };
        const timer = setTimeout(() => give("the compute host did not finish taking this session's copy in time"),
            options.timeoutMs ?? COMPUTE_CONTROL_COPY_TIMEOUT_MS);
        const onOuter = () => give("the copy to the compute host was given up on");
        options.signal?.addEventListener("abort", onOuter, { once: true });
        try {
            return await this.runCopy(plan, controller.signal);
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onOuter);
        }
    }

    private async runCopy(plan: ComputeCopyPlan, signal: AbortSignal): Promise<Record<string, string>> {
        /** Every digest the plan needs, with the worker path it was hashed from. */
        const sources = new Map<string, { resolved: string; size: number }>();
        for (const item of plan.items) {
            item.files.forEach((file, at) => {
                const resolved = item.resolved?.[at];
                if (!resolved || sources.has(file.digest)) return;
                sources.set(file.digest, { resolved, size: file.size });
            });
        }
        const missing = new Set<string>();
        for (const batch of chunkStrings(computeCopyDigests(plan.items))) {
            const answer = await this.request({ t: "have", digests: batch }, signal);
            for (const entry of Array.isArray(answer.missing) ? answer.missing : []) missing.add(String(entry));
        }
        for (const digest of missing) {
            const source = sources.get(digest);
            if (!source) continue;
            await this.sendBlob(digest, readForTransfer(source.resolved, digest, source.size), signal);
        }
        const placements: Record<string, string> = {};
        for (const item of computeCopyManifest(plan.items)) {
            const pieces = chunkManifestFiles(item.files);
            for (let at = 0; at < pieces.length; at += 1) {
                await this.request({ t: "manifest", name: item.name, digest: item.digest, at, files: pieces[at] }, signal);
            }
            const placed = await this.request({ t: "place", name: item.name, digest: item.digest, files: pieces.length === 0 ? [] : undefined }, signal);
            const where = placed.where;
            if (typeof where === "string" && where) placements[item.name] = where;
        }
        for (const [name, where] of Object.entries(placements)) this.placements[name] = where;
        return { ...this.placements };
    }

    private async sendBlob(digest: string, body: Buffer, signal?: AbortSignal): Promise<void> {
        const stream = this.channel.open("blob", { digest });
        let onAbort: (() => void) | undefined;
        const answered = new Promise<void>((resolve, reject) => {
            let said: Record<string, unknown> | null = null;
            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                if (onAbort) signal?.removeEventListener("abort", onAbort);
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
            if (signal) {
                onAbort = () => {
                    // A host that takes a file and never acknowledges it
                    // holds nothing here: the wait ends with the reason it
                    // ended for, and only then does the stream go — closing
                    // first would answer with the close instead.
                    finish(new Error("the compute host did not acknowledge a copied file in time"));
                    stream.close("the worker gave up on this transfer");
                };
                if (signal.aborted) onAbort();
                else signal.addEventListener("abort", onAbort, { once: true });
            }
        });
        if (!signal?.aborted) {
            await stream.write(body);
            await stream.end();
        }
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

    /**
     * The whole set of servers this session may now reach.
     *
     * Called every turn, including with an empty set. A ticket for a
     * server that is no longer in the set — a selection removed, an
     * allowlist narrowed, a deployment that has set the server away from
     * remote sessions — is revoked here, and whatever that ticket had
     * open is ended with it. Minting alone would leave the old one
     * standing, and the host holds its tickets for as long as its runtime
     * is warm.
     */
    reconcileSession(sessionId: string, servers: Iterable<string>): void {
        const keep = new Set(servers);
        for (const [ticket, grant] of [...this.grants]) {
            if (grant.sessionId !== sessionId || keep.has(grant.server)) continue;
            this.revoke(ticket, grant, "this session is no longer authorized to reach that server");
        }
    }

    /** Forget every ticket this session held: it is no longer on this host. */
    forgetSession(sessionId: string): void {
        for (const [ticket, grant] of [...this.grants]) {
            if (grant.sessionId !== sessionId) continue;
            this.revoke(ticket, grant, "this session has let go of this host");
        }
    }

    /** Drop one ticket and end everything that was open under it. */
    private revoke(ticket: string, grant: ForwardGrant, reason: string): void {
        this.grants.delete(ticket);
        this.byServer.delete(`${grant.sessionId}\u0000${grant.server}`);
        for (const [stream, entry] of [...this.active]) {
            if (entry.sessionId !== grant.sessionId || entry.server !== grant.server) continue;
            this.active.delete(stream);
            this.options.onRefusal?.({ ticket, reason });
            entry.stop();
        }
    }

    /** Test and diagnostic view: how many tickets stand. */
    get ticketCount(): number {
        return this.grants.size;
    }

    /** Test and diagnostic view: how many forwarded conversations are open. */
    get activeForwards(): number {
        return this.active.size;
    }

    close(): void {
        this.closed = true;
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
        for (const entry of [...this.active.values()]) entry.stop();
        this.active.clear();
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
        const liveLimit = this.options.maxLiveProcesses ?? COMPUTE_FORWARD_MAX_LIVE_PROCESSES;
        const startsLimit = this.options.maxProcessStartsPerMinute ?? COMPUTE_FORWARD_MAX_PROCESS_STARTS_PER_MINUTE;
        // Starting a server is work the host asks the worker to do. A host
        // that asks without limit would otherwise use up the worker's
        // processes, so both how many stand and how fast they arrive are
        // bounded, per host.
        if (this.children.size >= liveLimit) {
            this.refuse(stream, "", `this host already has as many servers started on the worker as it may (${liveLimit})`);
            return;
        }
        const now = Date.now();
        this.recentStarts = this.recentStarts.filter((at) => now - at < 60_000);
        if (this.recentStarts.length >= startsLimit) {
            this.refuse(stream, "", `this host has asked the worker to start more servers in the last minute than it may (${startsLimit})`);
            return;
        }
        this.recentStarts.push(now);
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
        this.active.set(stream, {
            sessionId: grant.sessionId, server: grant.server,
            stop: () => { this.stopChild(child); stream.close("this session no longer reaches that server"); },
        });
        const done = () => { this.active.delete(stream); };
        let carried = 0;
        child.stderr?.resume();
        child.stdout?.on("data", (chunk: Buffer) => {
            carried += chunk.length;
            if (carried > limit) {
                this.refuse(stream, "", `the server "${grant.server}" sent more than the ${limit} bytes one forwarded conversation carries`);
                this.stopChild(child);
                done();
                return;
            }
            // Pause while the channel takes the bytes: a server that
            // writes faster than the link carries must not be buffered
            // here without limit.
            child.stdout?.pause();
            void stream.write(chunk)
                .then(() => { if (!child.killed) child.stdout?.resume(); })
                .catch(() => { this.stopChild(child); done(); });
        });
        child.on("error", () => { done(); stream.close(`the server "${grant.server}" could not be started`); });
        child.on("exit", () => { this.children.delete(child); done(); stream.close(); });
        let received = 0;
        stream.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > limit) {
                this.refuse(stream, "", `more than the ${limit} bytes one forwarded conversation carries arrived for "${grant.server}"`);
                this.stopChild(child);
                done();
                return;
            }
            // Honour what the server's own input will take. Ignoring the
            // answer here is what lets a host fill the worker's memory
            // with bytes a slow server has not read: while the server's
            // input is full, nothing more is read off the link.
            const took = child.stdin?.write(chunk);
            if (took === false) {
                stream.holdChannel();
                child.stdin?.once("drain", () => stream.releaseChannel());
            }
        });
        stream.on("end", () => child.stdin?.end());
        stream.on("close", () => { done(); this.stopChild(child); });
    }

    /**
     * A server reached over HTTP. The call is made from here, so the
     * address and whatever the deployment configured never leave the
     * worker; what the caller sent travels unchanged.
     */
    private async forwardHttp(stream: ComputeChannelStream, grant: ForwardGrant): Promise<void> {
        const config = grant.config ?? {};
        const ticket = String(stream.meta.ticket ?? "");
        const limit = this.options.maxForwardBytes ?? COMPUTE_FORWARD_MAX_BYTES;
        const bufferLimit = this.options.maxBufferedBytes ?? COMPUTE_FORWARD_MAX_BUFFERED_BYTES;
        const method = String(stream.meta.method ?? "GET").toUpperCase();
        if (!COMPUTE_FORWARD_METHODS.has(method)) {
            this.refuse(stream, ticket, `this worker does not forward a "${method}" call`);
            return;
        }
        const destination = forwardDestination(config.url, stream.meta.path);
        if (!destination.ok) {
            this.refuse(stream, ticket, `the call for "${grant.server}" was not made: ${destination.reason}`);
            return;
        }

        const controller = new AbortController();
        // The deadline starts here, not when the body has arrived: a host
        // that opens a stream and sends its body slowly must not be able
        // to hold the worker's memory and a stream slot indefinitely.
        const timeoutMs = typeof config.timeout === "number" && config.timeout > 0
            ? config.timeout
            : this.options.forwardTimeoutMs ?? COMPUTE_FORWARD_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let given: string | null = null;
        const giveUp = (reason: string) => {
            if (given) return;
            given = reason;
            if (timer) clearTimeout(timer);
            controller.abort(new Error(reason));
        };
        const waitAgain = (reason: string) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => giveUp(reason), timeoutMs);
        };
        waitAgain(`the server "${grant.server}" did not answer within ${timeoutMs} ms`);
        this.active.set(stream, {
            sessionId: grant.sessionId, server: grant.server,
            stop: () => giveUp("this session no longer reaches that server"),
        });

        /**
         * The request body, as it arrives. It is handed to `fetch` as it
         * is read rather than collected first, so a call that carries a
         * large body costs the link, not the worker's memory.
         *
         * A stream that closes before it ends is the host giving up on
         * the call. It is cancellation, never a finished body: making the
         * call anyway is what let a host open and close streams to start
         * work the stream limit no longer bounds.
         */
        let queued: Buffer[] = [];
        let queuedBytes = 0;
        let ended = false;
        let wake: (() => void) | null = null;
        let received = 0;
        const nudge = () => { const go = wake; wake = null; go?.(); };
        stream.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > limit) {
                giveUp(`more than the ${limit} bytes one forwarded call carries arrived for "${grant.server}"`);
                return;
            }
            if (this.bufferedBytes + chunk.length > bufferLimit) {
                giveUp(`this host's forwarded calls are already holding the ${bufferLimit} bytes they may`);
                return;
            }
            queued.push(chunk);
            queuedBytes += chunk.length;
            this.bufferedBytes += chunk.length;
            // Nothing more is read off the link until the request has
            // taken what is already held.
            if (queuedBytes > 0) stream.holdChannel();
            nudge();
        });
        stream.on("end", () => { ended = true; nudge(); });
        stream.on("close", () => { giveUp("the compute host gave up on this call"); ended = true; nudge(); });

        const release = (bytes: number) => {
            this.bufferedBytes -= bytes;
            queuedBytes -= bytes;
            if (queuedBytes <= 0) stream.releaseChannel();
        };
        const hasBody = method !== "GET" && method !== "HEAD";
        const body = hasBody ? new ReadableStream<Uint8Array>({
            async pull(wanted) {
                for (;;) {
                    if (controller.signal.aborted) { wanted.error(controller.signal.reason ?? new Error("given up on")); return; }
                    const next = queued.shift();
                    if (next) { release(next.length); wanted.enqueue(new Uint8Array(next)); return; }
                    if (ended) { wanted.close(); return; }
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                        controller.signal.addEventListener("abort", () => { wake = null; resolve(); }, { once: true });
                    });
                }
            },
            cancel() { queued = []; stream.releaseChannel(); },
        }) : undefined;

        try {
            const answer = await fetch(destination.url, {
                method,
                headers: forwardHeaders(config.headers, (stream.meta.headers ?? {}) as Record<string, string | string[] | undefined>, grant.caller),
                ...(body ? { body, duplex: "half" } as Record<string, unknown> : {}),
                redirect: "manual",
                signal: controller.signal,
            });
            const headers: Record<string, string> = {};
            answer.headers.forEach((value, key) => {
                const name = key.toLowerCase();
                if (HOP_BY_HOP.has(name) || DECODED_AWAY.has(name)) return;
                headers[key] = value;
            });
            await stream.write(Buffer.from(JSON.stringify({ status: answer.status, headers }), "utf8"));
            if (answer.body) {
                let carried = 0;
                // From here the deadline is the gap between bytes, not the
                // whole conversation: a server that streams for an hour is
                // what a session on the worker gets too.
                waitAgain(`the server "${grant.server}" sent nothing for ${timeoutMs} ms`);
                for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
                    carried += chunk.byteLength;
                    if (carried > limit) break;
                    waitAgain(`the server "${grant.server}" sent nothing for ${timeoutMs} ms`);
                    await stream.write(Buffer.from(chunk));
                }
            }
            await stream.end();
        } catch (error) {
            const reason = given ?? String((error as Error)?.message ?? error);
            this.options.onRefusal?.({ ticket, reason: `the server "${grant.server}" could not be reached: ${reason}` });
            stream.close(reason);
        } finally {
            if (timer) clearTimeout(timer);
            this.active.delete(stream);
            this.bufferedBytes -= Math.max(queuedBytes, 0);
            queued = [];
            queuedBytes = 0;
            stream.releaseChannel();
        }
    }
}

/** Digest lists, in pieces a notice carries. */
function chunkStrings(values: string[], perBatch = 512): string[][] {
    const out: string[][] = [];
    for (let at = 0; at < values.length; at += perBatch) out.push(values.slice(at, at + perBatch));
    return out;
}

/**
 * A folder's file list, in pieces a notice carries.
 *
 * A notice is bounded, and the limits a deployment sets for a copy are
 * much larger than one notice holds — thousands of files. Sending the
 * manifest whole would make the advertised limits unreachable.
 */
function chunkManifestFiles<T>(files: T[], budget = 48 * 1024): T[][] {
    const out: T[][] = [];
    let current: T[] = [];
    let size = 0;
    for (const file of files) {
        const cost = JSON.stringify(file).length + 1;
        if (current.length > 0 && size + cost > budget) {
            out.push(current);
            current = [];
            size = 0;
        }
        current.push(file);
        size += cost;
    }
    if (current.length > 0) out.push(current);
    return out;
}

/**
 * One file's bytes, read for sending, checked here and not on the host.
 *
 * The plan resolved and confined this path, then the host was asked which
 * digests it was missing — a round trip the host decides the length of.
 * Reopening the planned path afterwards is what lets anything that can
 * write in a copied folder swap a file, or a folder above it, for a link
 * to somewhere the session may not see, and have the worker read it and
 * send it under the benign file's name.
 *
 * So: the resolved path must still resolve to itself, the final component
 * is opened without following a link, and the size and the exact digest
 * the plan recorded must both still hold. Anything else refuses, and the
 * remembered digest is dropped so the next turn hashes the file again.
 */
function readForTransfer(resolved: string, digest: string, size: number): Buffer {
    let handle: number | undefined;
    try {
        if (fs.realpathSync(resolved) !== resolved) {
            throw new Error("it is no longer the file that was read");
        }
        handle = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const stat = fs.fstatSync(handle);
        if (!stat.isFile()) throw new Error("it is no longer an ordinary file");
        if (stat.size !== size) throw new Error("its size changed while the copy was being prepared");
        const body = Buffer.allocUnsafe(stat.size);
        let at = 0;
        while (at < stat.size) {
            const read = fs.readSync(handle, body, at, stat.size - at, at);
            if (read <= 0) break;
            at += read;
        }
        if (at !== stat.size) throw new Error("it could not be read whole");
        const actual = createHash("sha256").update(body).digest("hex");
        if (actual !== digest) throw new Error("its contents changed while the copy was being prepared");
        return body;
    } catch (error) {
        forgetComputeDigest(resolved);
        throw new Error(`${resolved.split(/[\\/]/).pop() ?? "a file"} was not sent to the compute host: ${String((error as Error)?.message ?? error)}`);
    } finally {
        if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* already closed */ } }
    }
}
