import { createHash } from "node:crypto";
import type { EphemeralSessionRequest } from "./host-services.js";
import type { ModelProviderRegistry } from "./model-providers.js";
import { applyReasoningEffortToProviderConfig, providerTypeUsesWorkloadIdentity } from "./model-providers.js";
import type { ProviderCredential } from "./provider-store.js";
import { resolveProviderCredential, resolveRuntimeModelSelection } from "./provider-catalog.js";
import { attachWorkloadIdentity } from "./wif-credentials.js";
import { buildByokModelCapabilities } from "./copilot-model-options.js";
import { EphemeralSessionError } from "./ephemeral-errors.js";
import type { SessionConfig } from "@github/copilot-sdk";

type ModelOptions = Pick<SessionConfig,
    "reasoningEffort" | "contextTier" | "gitHubToken" | "provider" | "modelCapabilities">
    & { model: string; resolvedModel: string; credentialFingerprint: string };

type ModelSelectionRequest = Pick<EphemeralSessionRequest, "actor" | "model" | "reasoningEffort" | "contextTier" | "signal">;

/** Shared selection validation; each caller additionally closes its own fields. */
export function validateEphemeralModelSelection(request: ModelSelectionRequest): void {
    if (!request || typeof request !== "object" || Array.isArray(request)
        || !request.actor || typeof request.actor !== "object"
        || Object.keys(request.actor).some(key => key !== "provider" && key !== "subject")
        || typeof request.actor.provider !== "string" || !request.actor.provider.trim()
        || typeof request.actor.subject !== "string" || !request.actor.subject.trim()
        || ["none", "anonymous"].includes(request.actor.provider.trim().toLowerCase())
        || typeof request.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*:[^\s:]+$/.test(request.model)
        || (request.reasoningEffort != null && typeof request.reasoningEffort !== "string")
        || (request.contextTier != null && typeof request.contextTier !== "string")
        || (request.signal !== undefined && !(request.signal instanceof AbortSignal))) {
        throw new EphemeralSessionError("EPHEMERAL_INVALID_REQUEST");
    }
}

/** @internal Resolve only the requested credential; never a worker-wide registry. */
export function ephemeralProviderOptions(
    types: ModelProviderRegistry,
    credential: ProviderCredential,
    actorUserId: number,
    request: ModelSelectionRequest,
): ModelOptions {
    const modelName = request.model.slice(request.model.indexOf(":") + 1);
    const descriptor = types.getDescriptor(`${credential.typeId}:${modelName}`);
    if (!descriptor || credential.name !== request.model.slice(0, request.model.indexOf(":"))
        || (credential.class !== "shared" && credential.ownerUserId !== actorUserId)
        || (credential.class === "personal" && providerTypeUsesWorkloadIdentity(descriptor.providerType))) {
        throw new EphemeralSessionError("EPHEMERAL_MODEL_UNAVAILABLE");
    }
    // The normal resolver preserves defaults. Explicit unsupported settings
    // must be refused, including a setting on a model with no such capability.
    if ((request.reasoningEffort != null && !descriptor.supportedReasoningEfforts?.includes(request.reasoningEffort))
        || (request.contextTier != null && !descriptor.supportedContextTiers?.includes(request.contextTier))) {
        throw new EphemeralSessionError("EPHEMERAL_SETTINGS_UNSUPPORTED");
    }
    const resolved = resolveProviderCredential(types, credential, modelName);
    if (!resolved) throw new EphemeralSessionError("EPHEMERAL_MODEL_UNAVAILABLE");
    const selection = resolveRuntimeModelSelection(types, [credential], {
        requestedModel: request.model, requestedReasoning: request.reasoningEffort,
        requestedContext: request.contextTier,
        eligible: row => row.class === "shared" || row.ownerUserId === actorUserId,
    });
    if (selection.model !== request.model) throw new EphemeralSessionError("EPHEMERAL_MODEL_CHANGED");
    // The pinned runtime also accepts catalog "none"/"minimal"; its SDK type
    // omits them. Real-runtime tests and the effective-options check cover both.
    const reasoningEffort = selection.reasoning as SessionConfig["reasoningEffort"];
    const contextTier = selection.context as EphemeralSessionRequest["contextTier"];
    let provider: ModelOptions["provider"];
    if (resolved.type !== "github") {
        const configured = applyReasoningEffortToProviderConfig(attachWorkloadIdentity(resolved), descriptor, reasoningEffort);
        if (typeof configured.baseUrl !== "string") throw new EphemeralSessionError("EPHEMERAL_MODEL_UNAVAILABLE");
        provider = { ...configured, baseUrl: configured.baseUrl };
    }
    return {
        model: modelName,
        resolvedModel: selection.model,
        credentialFingerprint: createHash("sha256").update(JSON.stringify(resolved)).digest("hex"),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(contextTier ? { contextTier } : {}),
        ...(resolved.type === "github" ? { gitHubToken: resolved.githubToken } : {
            provider,
            modelCapabilities: buildByokModelCapabilities(descriptor, contextTier ?? undefined),
        }),
    };
}
