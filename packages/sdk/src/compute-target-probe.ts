import type { ComputeFailure, ComputePrincipal, ComputeTarget } from "./compute.js";

export const COMPUTE_TARGET_PROBE_ORCHESTRATION = "compute-target-probe";
export const COMPUTE_TARGET_PROBE_ACTIVITY = "probeComputeTarget";

export interface ComputeTargetProbeInput {
    targetId: string;
    principal: ComputePrincipal | null;
}

export type ComputeTargetProbeResult =
    | { ok: true; target: Omit<ComputeTarget, "config"> }
    | ComputeFailure;

export function withoutComputeTargetConfig(
    result: { ok: true; target: ComputeTarget } | ComputeFailure,
): ComputeTargetProbeResult {
    if (!result.ok) return result;
    const { id, name, kind, class: targetClass, ownerUserId, displayName, enabled, advertised } = result.target;
    return {
        ok: true,
        target: { id, name, kind, class: targetClass, ownerUserId, displayName, enabled, advertised },
    };
}

export function computeTargetProbeOrchestration(ctx: any, input: ComputeTargetProbeInput) {
    return (function* () {
        return yield ctx.scheduleActivity(COMPUTE_TARGET_PROBE_ACTIVITY, input);
    })();
}
