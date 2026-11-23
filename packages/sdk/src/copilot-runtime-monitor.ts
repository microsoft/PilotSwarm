/**
 * Watches the Copilot runtime child process behind each pooled CopilotClient.
 *
 * @github/copilot-sdk (1.0.13 through 1.0.34) spawns the runtime inside
 * `client.start()` and keeps the process, its exit and its connection state
 * internal: there is no public disconnect hook or state getter. When the
 * runtime dies (an OOM kill, for example), the SDK marks the connection and
 * its sessions disconnected but emits no idle to a running turn, so the turn
 * only ends at the 300 s inactivity watchdog, and the dead client stays pooled.
 *
 * Node publishes every new child process on the public `child_process`
 * diagnostics channel. A start runs inside an AsyncLocalStorage claim, and the
 * first runtime spawn (`--headless --stdio`) seen inside that claim belongs to
 * that client. Other spawns in the same async context (a tool handler that
 * runs a command, for example) are not claimed.
 *
 * @internal
 */
import { AsyncLocalStorage } from "node:async_hooks";
import diagnosticsChannel from "node:diagnostics_channel";
import type { ChildProcess } from "node:child_process";

/** Every message of a turn that ended because its runtime exited starts its explanation with this. */
export const COPILOT_RUNTIME_EXIT_MARKER = "Copilot runtime exited";

/** Matches the orchestration's isCopilotConnectionClosedError (orchestration/utils.ts). */
const CONNECTION_CLOSED_PATTERN = /\bConnection is closed\b/i;

/**
 * What the SDK and vscode-jsonrpc report once the runtime's connection is gone, plus the runtime monitor's own
 * marker. The turn inactivity watchdog (a runtime that may still be alive but wedged) is not among them: its turn
 * keeps the existing connection-closed retry on its warm session.
 */
const TRANSPORT_LOSS_PATTERNS: RegExp[] = [
    CONNECTION_CLOSED_PATTERN,
    /\bConnection is disposed\b/i,
    /\bPending response rejected since connection got disposed\b/i,
    /\bClient not connected\b/i,
    // SDK 1.0.34 marks every session of a closed connection disconnected; any later call on one throws this.
    /\bSession is disconnected\b/i,
    /\bSession disconnected while waiting\b/i,
    /\bCopilot runtime exited\b/,
];

/** Part of managed-session.ts TURN_INACTIVITY_ERROR_MARKER ("connection is closed or the subprocess is wedged"). */
const INACTIVITY_WATCHDOG_PATTERN = /\bsubprocess is wedged\b/i;

export interface CopilotRuntimeExit {
    pid: number | null;
    code: number | null;
    signal: NodeJS.Signals | null;
    /** The manager stopped this client itself (shutdown). */
    requested: boolean;
    /** The runtime exited before its client's start settled. */
    duringStartup: boolean;
}

export interface CopilotRuntimeWatch {
    /** The exit of the runtime this watch was bound to, or null while it runs. */
    exit(): CopilotRuntimeExit | null;
    /** Called once when that runtime exits, at once if it already did. Returns the unsubscribe. */
    onExit(listener: (exit: CopilotRuntimeExit) => void): () => void;
}

interface RuntimeState {
    child: ChildProcess | null;
    /** The runtime whose client start has settled successfully. */
    startedChild: ChildProcess | null;
    stopping: boolean;
}

interface ChildState {
    exit: CopilotRuntimeExit | null;
    listeners: Set<(exit: CopilotRuntimeExit) => void>;
}

interface SpawnClaim {
    open: boolean;
    claimed: boolean;
    claim(child: ChildProcess): void;
}

const spawnClaims = new AsyncLocalStorage<SpawnClaim>();
let subscribed = false;

function isRuntimeSpawn(child: ChildProcess): boolean {
    const args = child.spawnargs ?? [];
    return args.includes("--headless") && args.includes("--stdio");
}

function subscribeOnce(): void {
    if (subscribed) return;
    subscribed = true;
    diagnosticsChannel.subscribe("child_process", (message: unknown) => {
        const claim = spawnClaims.getStore();
        if (!claim?.open || claim.claimed) return;
        const child = (message as { process?: ChildProcess } | null)?.process;
        if (!child) return;
        // Node publishes from the ChildProcess constructor, before spawn() sets its arguments and pid. Look a
        // microtask later: spawn() has returned by then, and no exit event can have been emitted yet.
        queueMicrotask(() => {
            if (claim.claimed || !isRuntimeSpawn(child)) return;
            claim.claimed = true;
            claim.claim(child);
        });
    });
}

export class CopilotRuntimeMonitor {
    private readonly states = new WeakMap<object, RuntimeState>();
    private readonly children = new WeakMap<ChildProcess, ChildState>();

    constructor(private readonly onUnexpectedExit: (client: object, exit: CopilotRuntimeExit) => void) {}

    /** Run a client's start, binding the runtime it spawns to that client. */
    start<T>(client: object, start: () => Promise<T>): Promise<T> {
        subscribeOnce();
        const state = this.stateOf(client);
        const claim: SpawnClaim = { open: true, claimed: false, claim: (child) => this.bind(client, state, child) };
        return spawnClaims.run(claim, start).then(
            (value) => {
                claim.open = false;
                if (state.child && !this.children.get(state.child)?.exit) state.startedChild = state.child;
                return value;
            },
            (error: unknown) => {
                claim.open = false;
                throw error;
            },
        );
    }

    /** The current runtime of a client, as a watch that keeps reporting that runtime's exit. */
    watch(client: object): CopilotRuntimeWatch {
        const child = this.states.get(client)?.child ?? null;
        const childState = child ? this.children.get(child) ?? null : null;
        return {
            exit: () => childState?.exit ?? null,
            onExit: (listener) => {
                if (!childState) return () => {};
                if (childState.exit) {
                    listener(childState.exit);
                    return () => {};
                }
                const once = (value: CopilotRuntimeExit) => {
                    childState.listeners.delete(once);
                    listener(value);
                };
                childState.listeners.add(once);
                return () => { childState.listeners.delete(once); };
            },
        };
    }

    /** The client's runtime exited without the manager stopping it: the client must not be used again. */
    isLost(client: object): boolean {
        const child = this.states.get(client)?.child;
        const exit = child ? this.children.get(child)?.exit : null;
        return Boolean(exit && !exit.requested);
    }

    /** The manager is stopping this client: its runtime's exit is expected. */
    markStopping(client: object): void {
        this.stateOf(client).stopping = true;
    }

    /** The pid of the client's current runtime (diagnostics and tests). */
    pid(client: object): number | null {
        return this.states.get(client)?.child?.pid ?? null;
    }

    private stateOf(client: object): RuntimeState {
        let state = this.states.get(client);
        if (!state) {
            state = { child: null, startedChild: null, stopping: false };
            this.states.set(client, state);
        }
        return state;
    }

    private bind(client: object, state: RuntimeState, child: ChildProcess): void {
        const childState: ChildState = { exit: null, listeners: new Set() };
        this.children.set(child, childState);
        state.child = child;
        child.once("exit", (code, signal) => {
            const exit: CopilotRuntimeExit = {
                pid: child.pid ?? null,
                code: code ?? null,
                signal: signal ?? null,
                requested: state.stopping,
                duringStartup: state.startedChild !== child,
            };
            childState.exit = exit;
            for (const listener of [...childState.listeners]) {
                try { listener(exit); } catch {}
            }
            childState.listeners.clear();
            if (!exit.requested && state.child === child) {
                try { this.onUnexpectedExit(client, exit); } catch {}
            }
        });
    }
}

/** How a runtime exit is told: pid, exit code and signal. */
export function describeCopilotRuntimeExit(exit: CopilotRuntimeExit): string {
    return `pid ${exit.pid ?? "unknown"}, code ${exit.code ?? "none"}, signal ${exit.signal ?? "none"}`;
}

/**
 * The error a turn returns when its runtime exited. It names the connection as closed, so the orchestration takes
 * its connection-closed retry: the warm session is dropped and the retry resumes on a fresh runtime from the last
 * committed snapshot.
 */
export function copilotRuntimeExitMessage(exit: CopilotRuntimeExit): string {
    return `${COPILOT_RUNTIME_EXIT_MARKER} (${describeCopilotRuntimeExit(exit)}) during the turn: Connection is closed.`;
}

/** The runtime's connection is gone, so the warm session that used it can never run again. */
export function isCopilotTransportLossMessage(message: unknown): boolean {
    if (typeof message !== "string" || !message) return false;
    if (INACTIVITY_WATCHDOG_PATTERN.test(message) && !message.includes(COPILOT_RUNTIME_EXIT_MARKER)) return false;
    return TRANSPORT_LOSS_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * A transport-loss message the orchestration's connection-closed check does not already match (a disposed
 * connection, for example), with that wording appended so it takes the same retry.
 */
export function transportLossMessage(message: string): string {
    if (CONNECTION_CLOSED_PATTERN.test(message)) return message;
    return `${message} (Connection is closed: the Copilot runtime connection was lost.)`;
}
