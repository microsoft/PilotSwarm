import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Tool } from "@github/copilot-sdk";

export interface ComputeExecutionIdentity {
    sessionId: string;
    transcriptEpoch: number;
    turnKey: string;
    attemptId: string;
    workerNodeId: string;
    generation: string;
}

export interface ComputeExecutionStatus {
    identity: ComputeExecutionIdentity;
    phase: "active" | "sealed" | "committed" | "unknown" | "released";
    pendingOperations: number;
    detail?: string | null;
    binding?: { targetId: string; targetName: string; kind: string; host: { kind: string; id: string; incarnation: string }; runtimeGeneration?: string } | null;
}

/** Trusted authority. An admitted asynchronous operation pins its generation until it settles. */
export interface ComputeExecutionAuthority {
    acquire(request: Omit<ComputeExecutionIdentity, "generation">): Promise<ComputeExecutionIdentity>;
    runCurrent<T>(identity: ComputeExecutionIdentity, operationId: string, operation: () => Promise<T>): Promise<T>;
    seal(identity: ComputeExecutionIdentity): Promise<void>;
    finish(identity: ComputeExecutionIdentity, disposition: "committed" | "unknown" | "released"): Promise<void>;
    inspect(sessionId: string): Promise<ComputeExecutionStatus | null>;
    recordBinding?(identity: ComputeExecutionIdentity, binding: NonNullable<ComputeExecutionStatus["binding"]>): Promise<void>;
    requestReconciliation?(sessionId: string): Promise<void>;
    listReconciliationRequests?(): Promise<ComputeExecutionStatus[]>;
    reconcile?(identity: ComputeExecutionIdentity, verify: (status: ComputeExecutionStatus) => Promise<"retired" | "unknown">): Promise<boolean>;
    recordFailure?(identity: ComputeExecutionIdentity, detail: string): Promise<void>;
}

export class ComputeExecutionError extends Error {
    readonly code = "COMPUTE_EXECUTION_UNCERTAIN";
}

const admitted = new AsyncLocalStorage<{
    attempt: ComputeExecutionAttempt; active: boolean; pending: Set<Promise<unknown>>; failures: unknown[];
}>();
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/** One turn's worker-side admission; old callbacks keep this object, never a newer turn's identity. */
export class ComputeExecutionAttempt {
    private accepting = true;
    private closed = false;
    private failures: unknown[] = [];
    private readonly pending = new Set<Promise<unknown>>();

    constructor(
        readonly identity: ComputeExecutionIdentity,
        private readonly authority: ComputeExecutionAuthority,
        private readonly context?: <T>(operation: () => Promise<T>) => Promise<T>,
    ) {}

    async current<T>(operation: () => Promise<T>): Promise<T> {
        return this.run(operation, false);
    }

    /** Trusted lifecycle operations may publish after callback admission closes. */
    async lifecycle<T>(operation: () => Promise<T>, operationId?: string): Promise<T> {
        return this.run(operation, true, operationId);
    }

    private async run<T>(operation: () => Promise<T>, lifecycle: boolean, operationId?: string): Promise<T> {
        if (this.closed) throw new ComputeExecutionError("This compute attempt is no longer current");
        const scope = admitted.getStore();
        if (scope?.attempt === this && !scope.active) throw new ComputeExecutionError("A detached continuation must acquire a new current admission");
        if (!this.accepting && !lifecycle && !(scope?.attempt === this && scope.active)) {
            throw new ComputeExecutionError("Compute effect admission is closed");
        }
        const run = () => this.context ? this.context(operation) : operation();
        const nested = scope?.attempt === this && scope.active;
        const pending = nested ? run()
            : this.authority.runCurrent(this.identity, operationId ?? randomUUID(), async () => {
                if (this.closed) throw new ComputeExecutionError("This compute attempt is no longer current");
                const admission = { attempt: this, active: true, pending: new Set<Promise<unknown>>(), failures: [] as unknown[] };
                const errors: unknown[] = [];
                let result!: T;
                try { result = await admitted.run(admission, run); }
                catch (error) { errors.push(error); }
                try {
                    while (admission.pending.size) {
                        const settled = await Promise.allSettled([...admission.pending]);
                        errors.push(...settled.filter(value => value.status === "rejected").map(value => value.reason));
                    }
                    errors.push(...admission.failures);
                } finally { admission.active = false; }
                const unique = [...new Set(errors)];
                if (unique.length === 1) throw unique[0];
                if (unique.length) throw new AggregateError(unique, "Admitted compute work failed");
                return result;
            });
        if (nested) scope.pending.add(pending);
        this.pending.add(pending);
        try { return await pending; }
        catch (error) { if (nested) scope.failures.push(error); throw error; }
        finally {
            if (nested) scope.pending.delete(pending);
            this.pending.delete(pending);
        }
    }

    async callback<T>(operation: () => Promise<T>): Promise<T> {
        if (!this.accepting) throw new ComputeExecutionError("Compute callback arrived after the turn boundary");
        const pending = this.current(async () => {
            if (!this.accepting) throw new ComputeExecutionError("Compute callback arrived after the turn boundary");
            return operation();
        });
        this.pending.add(pending);
        try { return await pending; }
        catch (error) { this.failures.push(error); throw error; }
        finally { this.pending.delete(pending); }
    }

    tools(tools: Tool<any>[]): Tool<any>[] {
        return tools.map(tool => {
            const handler = tool.handler;
            return handler ? { ...tool, handler: (input, invocation) => this.callback(async () => handler(input, invocation)) } : tool;
        });
    }

    callbacks<T extends object>(target: T): T {
        return new Proxy(target, {
            get: (object, key) => {
                const value: unknown = Reflect.get(object, key, object);
                return typeof value === "function" ? (...args: unknown[]) =>
                    this.callback(async () => Reflect.apply(value, object, args)) : value;
            },
        });
    }

    guard<T extends object>(target: T, operationIds: Record<string, string> = {}): T {
        return new Proxy(target, {
            get: (object, key) => {
                const value: unknown = Reflect.get(object, key, object);
                if (typeof value === "function") return (...args: unknown[]) => this.lifecycle(async () => Reflect.apply(value, object, args), operationIds[String(key)]);
                if ((key === "providers" || key === "features") && value && typeof value === "object") return this.guard(value);
                return value;
            },
        });
    }

    /** Keep streamed model work admitted until its consumer closes, cancels or fails the body. */
    async forward(operation: () => Promise<Response>): Promise<Response> {
        const ready = deferred<Response>();
        const pending = this.callback(async () => {
            const response = await operation();
            if (!response.body) { ready.resolve(response); return; }
            const reader = response.body.getReader();
            const consumed = deferred<void>();
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        const next = await reader.read();
                        if (next.done) { controller.close(); consumed.resolve(); }
                        else controller.enqueue(next.value);
                    } catch (error) { controller.error(error); consumed.reject(error); }
                },
                async cancel(reason) {
                    try { await reader.cancel(reason); consumed.resolve(); }
                    catch (error) { consumed.reject(error); throw error; }
                },
            });
            ready.resolve(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }));
            await consumed.promise;
        });
        void pending.catch(error => ready.reject(error));
        return ready.promise;
    }

    /** Close admission first, then wait for every admitted operation, even if one fails. */
    async drain(): Promise<void> {
        this.accepting = false;
        const errors = [...this.failures];
        while (this.pending.size) {
            const settled = await Promise.allSettled([...this.pending]);
            errors.push(...settled.filter(result => result.status === "rejected").map(result => result.reason));
        }
        this.failures = [];
        if (errors.length) throw new AggregateError(errors, "Compute admission drain failed");
        await this.authority.seal(this.identity);
    }

    async finish(disposition: "committed" | "unknown" | "released"): Promise<void> {
        this.accepting = false;
        try {
            while (this.pending.size) {
                const settled = await Promise.allSettled([...this.pending]);
                if (settled.some(result => result.status === "rejected")) disposition = "unknown";
            }
            if (this.failures.length) disposition = "unknown";
            await this.authority.finish(this.identity, disposition);
        } finally { this.closed = true; }
    }
}
