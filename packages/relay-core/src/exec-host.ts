/**
 * Host end of the exec protocol. Runs on the machine that executes commands.
 *
 * For each connection:
 * 1. Send hello with a fresh challenge, and nothing else
 * 2. Wait for the caller's auth. Not a trusted cluster → auth_failed, close
 * 3. Send ready: host key + signature over the cluster's challenge, host
 *    summary, allow list, and (first contact only) the activation secret.
 *    The secret goes out only after the cluster proved who it is.
 * 4. Handle host_ok (activation confirmed), grant_update (fresh credential),
 *    host_refused, and exec requests whose owner is allowed
 * 5. When the connection closes, kill every command still running for it
 */

import os from "node:os";
import { newChallenge, type HostSigner, type TrustedClusters } from "./auth.js";
import {
    PROTOCOL_VERSION,
    checkExecRequest,
    decodeMessage,
    encodeMessage,
    type ExecRequest,
    type ExecResult,
    type HostSummary,
    type RelayMessage,
} from "./protocol.js";
import { ANY_OWNER, type OwnerAllowList } from "./owner-allowlist.js";
import { runCommand, type RunningCommand } from "./run-command.js";
import type { RelayConnection } from "./transport.js";

export interface HostOptions {
    /** Sent in ready. Its defaultCwd is where commands run when a request does not set cwd. */
    host: HostSummary;
    /** Clusters allowed to connect. A caller that cannot sign for one of them is closed. */
    trustedClusters: TrustedClusters;
    /** This host's key. The cluster checks it against the key it pinned at activation. */
    hostSigner: HostSigner;
    /** The profile's one-time secret, until activation is confirmed. Read per connection. */
    activationSecret?: () => string | undefined;
    /** The cluster confirmed activation: drop the secret. */
    onActivated?: () => void;
    /** The cluster pushed a fresh relay credential (opaque; for the provider). */
    onGrantUpdate?: (grant: unknown) => void;
    /** The endpoint this host listens on (RelayTransport.endpointId). The cluster's signature must name it. */
    endpointId: string;
    /**
     * Session owners this host serves. When set, a request whose session owner
     * is missing or not on the list is rejected and nothing runs. When unset,
     * every request runs.
     */
    allowedOwners?: OwnerAllowList;
    /** How long a caller has to authenticate. Default 15 s. */
    authTimeoutMs?: number;
    /** Bytes kept per stream in the inline result. Default 64 KiB. */
    maxInlineBytes?: number;
    log?: (line: string) => void;
}

export function describeThisHost(defaultCwd: string = process.cwd()): HostSummary {
    return {
        hostname: os.hostname(),
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        user: os.userInfo().username,
        elevated: typeof process.getuid === "function" && process.getuid() === 0,
        relayPid: process.pid,
        defaultCwd,
    };
}

export interface ServedConnection {
    /** Kills every running command at once (SIGKILL) and closes the connection. */
    stop(): void;
}

export function serveConnection(connection: RelayConnection, options: HostOptions): ServedConnection {
    const log = options.log ?? (() => {});
    const running = new Map<string, RunningCommand>();
    const maxInlineBytes = options.maxInlineBytes ?? 64 * 1024;
    const short = connection.id.slice(0, 8);
    const challenge = newChallenge();
    let cluster: string | undefined;

    const send = (message: RelayMessage) =>
        connection.send(encodeMessage(message)).catch((error: Error) => {
            log(`could not send '${message.type}' on ${short}: ${error.message}`);
        });

    const refuse = (reason: string) => {
        log(`refused caller ${short}: ${reason}`);
        void send({ type: "auth_failed", reason }).finally(() => connection.close("auth failed"));
    };

    const authTimer = setTimeout(() => {
        if (!cluster) refuse("did not authenticate in time");
    }, options.authTimeoutMs ?? 15_000);
    authTimer.unref();

    connection.onFrame((frame) => {
        let message: RelayMessage;
        try {
            message = decodeMessage(frame);
        } catch (error) {
            log(`closing connection ${short}: ${(error as Error).message}`);
            connection.close("protocol error");
            return;
        }

        if (!cluster) {
            // Nothing but auth is accepted until the caller proves which cluster it is.
            clearTimeout(authTimer);
            if (message.type !== "auth") {
                refuse(`sent '${message.type}' before authenticating`);
                return;
            }
            if (!options.trustedClusters.check(message.cluster, message.signature, options.endpointId, challenge)) {
                refuse(`not a trusted cluster (${String(message.cluster).slice(0, 20)}…)`);
                return;
            }
            if (typeof message.challenge !== "string" || message.challenge.length < 16) {
                refuse("the cluster sent no challenge for the host");
                return;
            }
            cluster = message.cluster;
            log(`caller ${short} is trusted cluster ${cluster.slice(0, 20)}…`);
            const activationSecret = options.activationSecret?.();
            void send({
                type: "ready",
                host: options.host,
                serves: options.allowedOwners?.toServed() ?? ANY_OWNER,
                hostKey: { fingerprint: options.hostSigner.fingerprint, publicKeyPem: options.hostSigner.publicKeyPem },
                signature: options.hostSigner.signChallenge(cluster, options.endpointId, message.challenge),
                ...(activationSecret ? { activationSecret } : {}),
            });
            return;
        }

        switch (message.type) {
            case "exec":
                handleExec(message);
                return;
            case "host_ok":
                if (message.activated) {
                    log(`cluster activated this host (key ${options.hostSigner.fingerprint.slice(0, 20)}…)`);
                    options.onActivated?.();
                }
                return;
            case "host_refused":
                log(`cluster refused this host: ${message.reason}`);
                connection.close("host refused");
                return;
            case "grant_update":
                options.onGrantUpdate?.(message.grant);
                return;
            default:
                log(`closing connection ${short}: host does not accept '${message.type}' messages`);
                connection.close("protocol error");
        }
    });

    function handleExec(request: ExecRequest): void {
        const problem = checkExecRequest(request);
        if (problem) {
            void send({ type: "exec_result", id: String(request.id), status: "rejected", error: problem });
            return;
        }
        if (running.has(request.id)) {
            // A repeated id must not start a second process.
            log(`ignored a repeated request id ${request.id.slice(0, 8)}`);
            return;
        }

        const owner = request.session?.owner;
        const who = owner ? `${owner.email ?? owner.subject} (${owner.provider}), session ${request.session!.id.slice(0, 8)}` : "no session owner";
        if (options.allowedOwners && !options.allowedOwners.allows(owner)) {
            log(`rejected ${request.id.slice(0, 8)} for ${who}: not on this relay's allow list`);
            void send({
                type: "exec_result",
                id: request.id,
                status: "rejected",
                error: owner
                    ? `this relay does not serve sessions owned by ${owner.email ?? owner.subject}`
                    : "this relay only serves sessions with a known owner",
            });
            return;
        }

        const cwd = request.cwd ?? options.host.defaultCwd;
        log(`exec ${request.id.slice(0, 8)} for ${who} ${JSON.stringify(request.command)}${cwd ? ` cwd=${cwd}` : ""}`);
        const command = runCommand({
            command: request.command,
            cwd,
            timeoutSeconds: request.timeoutSeconds,
            stdin: request.stdin,
            maxInlineBytes,
        });
        running.set(request.id, command);

        void command.outcome.then((outcome) => {
            running.delete(request.id);
            if (outcome.status === "start_failed") {
                log(`  ${request.id.slice(0, 8)} did not start: ${outcome.error}`);
                void send({ type: "exec_result", id: request.id, status: "start_failed", error: outcome.error });
                return;
            }
            const how = outcome.timedOut ? "timed out" : `exit ${outcome.exitCode ?? outcome.signal}`;
            log(
                `  ${request.id.slice(0, 8)} ${how} in ${outcome.durationMs} ms ` +
                    `(stdout ${outcome.stdout.bytes} B, stderr ${outcome.stderr.bytes} B)`,
            );
            const result: ExecResult = { type: "exec_result", id: request.id, ...outcome };
            void send(result);
        });
    }

    connection.onClose((info) => {
        clearTimeout(authTimer);
        if (running.size > 0) {
            log(`connection ${short} closed (${info.code}); killing ${running.size} running command(s)`);
        }
        for (const command of running.values()) command.kill();
    });

    void send({ type: "hello", protocolVersion: PROTOCOL_VERSION, challenge });

    return {
        stop() {
            for (const command of running.values()) command.kill(true);
            connection.close("relay stopping");
        },
    };
}
