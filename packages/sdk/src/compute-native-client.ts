import { ComputeControlLink } from "./compute-control.js";
import { openTcpPipe } from "./compute-bridge.js";
import { runWorkerHandshake } from "./compute-handshake.js";
import { checkRemoteEndpoint, type ComputeRuntimeEndpoint } from "./compute.js";
import type { ComputeExecutionIdentity } from "./compute-execution.js";
import type { ComputeCheckpointBarrier, ComputeNativeCapture, ComputeNativeState } from "./compute-native-state.js";

/** Public worker-side client for the common native host. Contains no provider-specific state transport. */
export class ComputeNativeStateClient {
    private constructor(private readonly link: ComputeControlLink) {}

    static async connect(endpoint: Exclude<ComputeRuntimeEndpoint, { transport: "local" }>, signal: AbortSignal): Promise<ComputeNativeStateClient> {
        checkRemoteEndpoint(endpoint, "native-state");
        const pipe = await openTcpPipe(endpoint.address, signal);
        try {
            await runWorkerHandshake(pipe, endpoint.handshake!, { purpose: "control" });
            const link = new ComputeControlLink(pipe);
            await link.hostFacts();
            return new ComputeNativeStateClient(link);
        } catch (error) {
            pipe.destroy();
            throw error;
        }
    }

    describe(): Promise<import("./compute-native-state.js").ComputeNativeStateDescription> {
        return this.link.nativeStateCall({ op: "describe" });
    }
    prepare(identity: ComputeExecutionIdentity, state?: ComputeNativeState): Promise<{ runtimeAddress: string; connectionToken: string; runtimeGeneration: string }> {
        return this.link.nativeStateCall({ op: "prepare", identity, ...(state ? { state } : {}) });
    }
    beginCheckpoint(identity: ComputeExecutionIdentity): Promise<ComputeCheckpointBarrier> {
        return this.link.nativeStateCall({ op: "begin-checkpoint", identity });
    }
    exportState(identity: ComputeExecutionIdentity, barrierId: string): Promise<ComputeNativeCapture> {
        return this.link.nativeStateCall({ op: "export-state", identity, barrierId });
    }
    endCheckpoint(identity: ComputeExecutionIdentity, barrierId: string, disposition: "committed" | "discarded"): Promise<void> {
        return this.link.nativeStateCall({ op: "end-checkpoint", identity, barrierId, disposition });
    }
    retire(identity: ComputeExecutionIdentity): Promise<{ runtimeGeneration: string; evidence: Record<string, unknown> }> {
        return this.link.nativeStateCall({ op: "retire", identity });
    }
    close(): void { this.link.close(); }
}
