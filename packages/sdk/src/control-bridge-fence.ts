import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Review S4/S5 (#376): the control-tool bridge runs a tool's effects inline in the turn (spawn_agent creates and
 * starts a child, message_agent queues a message). A turn that ends while such a call is in flight (its Copilot
 * runtime died, the user stopped it, the activity attempt exited) is not committed when the runtime was lost, and
 * the retry runs the turn again from the last commit. The SDK aborts the call's controller without awaiting the
 * handler, so the handler would otherwise go on creating and starting a child after the retry began its own.
 *
 * The fence is check-based, never awaited: a bridge call runs in the context of the turn that made it, and the
 * bridge checks that the turn and the activity attempt are still open before each external step. A step already
 * started completes. The effects themselves are at-least-once: an effect completed before the loss runs again
 * when the retry asks for it again.
 */
const bridgeCallTurn = new AsyncLocalStorage<AbortSignal>();

export class ControlBridgeClosedError extends Error {
    constructor(tool: string, step: string, reason: string) {
        super(`${tool} stopped before ${step}: ${reason}.`);
        this.name = "ControlBridgeClosedError";
    }
}

/** The bridge, with each of its methods run in the context of the turn whose signal is given. */
export function fenceControlBridge<T extends object>(bridge: T | undefined, turnSignal: AbortSignal | undefined): T | undefined {
    if (!bridge || !turnSignal) return bridge;
    return new Proxy(bridge, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => bridgeCallTurn.run(turnSignal, () => Reflect.apply(value, target, args));
        },
    });
}

/** Throws when the bridge call's turn ended, or `attemptClosed` says its activity attempt exited. */
export function assertControlBridgeOpen(tool: string, step: string, attemptClosed: boolean): void {
    if (attemptClosed) throw new ControlBridgeClosedError(tool, step, "the turn's activity attempt has ended");
    if (bridgeCallTurn.getStore()?.aborted) throw new ControlBridgeClosedError(tool, step, "the turn that asked for it has ended");
}
