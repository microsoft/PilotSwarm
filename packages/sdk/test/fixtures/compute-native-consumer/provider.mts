import type {
    ComputeProvider, ComputeHostNativeFactory, ComputeExecutionIdentity, ComputeNativeStateOptions,
} from "pilotswarm-sdk";

export function providerFixture(options: ComputeNativeStateOptions): ComputeProvider {
    return {
        kind: "fixture",
        capabilities: {
            files: "none",
            nativeState: { protocol: 1, profileId: options.profile.id,
                sdkVersion: options.profile.sdkVersion, runtimeVersion: options.profile.runtimeVersion },
        },
        async bind(request) {
            return { ok: true, host: { kind: "fixture", id: request.sessionId, incarnation: "fixture" } };
        },
        async connect() {
            return { ok: false, code: "FIXTURE_ONLY", message: "No live runtime is launched by this type fixture" };
        },
        async verifyCheckpoint() {
            return { ok: false, code: "FIXTURE_ONLY", message: "A real provider must verify trusted supervision" };
        },
        async inspectExecution() { return { state: "unknown" }; },
        async retireExecution() { return { state: "unknown" }; },
    };
}

export const bootstrapFixture: ComputeHostNativeFactory = async () => {
    throw new Error("Type fixture only; deployment supplies qualified supervision");
};
export const identityFixture: ComputeExecutionIdentity = {
    sessionId: "fixture", transcriptEpoch: 0, turnKey: "turn", attemptId: "attempt",
    workerNodeId: "worker", generation: "generation",
};
