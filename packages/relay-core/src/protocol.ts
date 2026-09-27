/**
 * The messages that travel inside relay frames. One JSON message per frame.
 * This layer is the same for every relay service.
 *
 *   host    → cluster  hello         challenge H; the host reveals nothing else yet
 *   cluster → host     auth          cluster signature over H, plus challenge C
 *   host    → cluster  auth_failed   (then close) if the cluster is not trusted
 *   host    → cluster  ready         host signature over C, host key, host summary,
 *                                    allow list; the activation secret on first contact
 *   cluster → host     host_ok       the cluster accepted the host (activated: true on first contact)
 *   cluster → host     host_refused  (then close) if the host key is wrong
 *   cluster → host     grant_update  a fresh relay credential for the host to listen with
 *   cluster → host     exec          any number, only after host_ok
 *   host    → cluster  exec_result   one per exec, matched by id
 */

export const PROTOCOL_VERSION = 4;

/** What the host says about itself. The caller must treat every field as untrusted. */
export interface HostSummary {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    user: string;
    /** True when the relay runs as root. Commands then run as root too. */
    elevated: boolean;
    relayPid: number;
    /** Where commands run when a request does not set cwd. */
    defaultCwd: string;
}

/**
 * Whose sessions the host serves (its --allow list). The caller checks each
 * session's owner against this before sending a command; the host checks again.
 */
export interface ServedOwners {
    /** True for --allow-any. */
    anyOwner: boolean;
    /** Lower-case emails. */
    emails: string[];
    /** Lower-case Entra object ids. */
    objectIds: string[];
}

export interface HelloMessage {
    type: "hello";
    protocolVersion: number;
    /** Fresh random value for this connection (H). See auth.ts. */
    challenge: string;
}

export interface AuthMessage {
    type: "auth";
    /** Fingerprint of the cluster's public key. */
    cluster: string;
    /** Signature over clusterStatement(cluster, endpoint, H). */
    signature: string;
    /** Fresh random value (C) the host must sign back. */
    challenge: string;
}

export interface AuthFailedMessage {
    type: "auth_failed";
    reason: string;
}

/** Sent only after the caller proved it is a trusted cluster. */
export interface ReadyMessage {
    type: "ready";
    host: HostSummary;
    serves: ServedOwners;
    hostKey: { fingerprint: string; publicKeyPem: string };
    /** Signature over hostStatement(host, cluster, endpoint, C). */
    signature: string;
    /** Only on first contact: the one-time secret from the host's profile. */
    activationSecret?: string;
}

export interface HostOkMessage {
    type: "host_ok";
    /** True when this connection activated the host (its key is now pinned). */
    activated: boolean;
}

export interface HostRefusedMessage {
    type: "host_refused";
    reason: string;
}

/** A fresh relay credential, opaque to the core. Only the provider reads it. */
export interface GrantUpdateMessage {
    type: "grant_update";
    grant: unknown;
}

/** Same shape PilotSwarm stores for a session owner. For Entra: subject = oid. */
export interface SessionOwner {
    provider: string;
    subject: string;
    email?: string;
}

/**
 * The session a command runs for, as reported by the cluster. The connection
 * is authenticated both ways, so this is the cluster's word, not a stranger's.
 */
export interface SessionContext {
    id: string;
    owner: SessionOwner;
}

export interface ExecRequest {
    type: "exec";
    id: string;
    session?: SessionContext;
    /** Executable and arguments. No shell runs unless the caller names one. */
    command: string[];
    cwd?: string;
    timeoutSeconds: number;
    stdin?: string;
}

export interface StreamResult {
    /** UTF-8 text, cut at the inline limit. */
    text: string;
    /** Total bytes the process wrote, including any bytes past the limit. */
    bytes: number;
    /** SHA-256 of every byte the process wrote. */
    sha256: string;
    truncated: boolean;
}

export type ExecResult =
    | {
          type: "exec_result";
          id: string;
          status: "exited";
          exitCode: number | null;
          signal: string | null;
          timedOut: boolean;
          durationMs: number;
          stdout: StreamResult;
          stderr: StreamResult;
      }
    | {
          type: "exec_result";
          id: string;
          /** start_failed: the executable or cwd is bad. rejected: the request itself is bad. */
          status: "start_failed" | "rejected";
          error: string;
      };

export type RelayMessage =
    | HelloMessage
    | AuthMessage
    | AuthFailedMessage
    | ReadyMessage
    | HostOkMessage
    | HostRefusedMessage
    | GrantUpdateMessage
    | ExecRequest
    | ExecResult;

export const MAX_TIMEOUT_SECONDS = 300;

const MESSAGE_TYPES = new Set(["hello", "auth", "auth_failed", "ready", "host_ok", "host_refused", "grant_update", "exec", "exec_result"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeMessage(message: RelayMessage): Uint8Array {
    return encoder.encode(JSON.stringify(message));
}

export function decodeMessage(frame: Uint8Array): RelayMessage {
    const value = JSON.parse(decoder.decode(frame)) as { type?: unknown };
    if (!MESSAGE_TYPES.has(value.type as string)) {
        throw new Error(`unknown relay message type: ${String(value.type)}`);
    }
    return value as RelayMessage;
}

/** Returns an error message, or undefined when the request is valid. */
export function checkExecRequest(request: ExecRequest): string | undefined {
    if (typeof request.id !== "string" || request.id.length === 0) return "id must be a non-empty string";
    if (!Array.isArray(request.command) || request.command.length === 0) return "command must be a non-empty array";
    if (!request.command.every((part) => typeof part === "string")) return "every command element must be a string";
    if (request.command[0].length === 0) return "command[0] must name an executable";
    if (request.cwd !== undefined && typeof request.cwd !== "string") return "cwd must be a string";
    if (request.stdin !== undefined && typeof request.stdin !== "string") return "stdin must be a string";
    if (request.session !== undefined) {
        const { session } = request;
        if (typeof session !== "object" || session === null) return "session must be an object";
        if (typeof session.id !== "string" || session.id.length === 0) return "session.id must be a non-empty string";
        const owner = session.owner as Partial<SessionOwner> | undefined;
        if (typeof owner !== "object" || owner === null) return "session.owner must be an object";
        if (typeof owner.provider !== "string" || typeof owner.subject !== "string") return "session.owner needs provider and subject";
        if (owner.email !== undefined && typeof owner.email !== "string") return "session.owner.email must be a string";
    }
    if (
        !Number.isInteger(request.timeoutSeconds) ||
        request.timeoutSeconds < 1 ||
        request.timeoutSeconds > MAX_TIMEOUT_SECONDS
    ) {
        return `timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`;
    }
    return undefined;
}
