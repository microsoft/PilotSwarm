import type {
    SessionCatalog,
    WorkflowDefinitionRecord,
} from "../cms.js";
import type { ArtifactStore } from "../session-store.js";
import type { WorkflowDefinitionSource } from "../types.js";
import {
    WORKFLOW_COMPILER_VERSION,
    executeWorkflowTransitionRegistration,
    workflowCompiledManifestSha256,
    type CompiledWorkflowExecutableStateManifest,
    type CompiledWorkflowManifest,
    type WorkflowAdvanceDirective,
} from "./compiler.js";
import type { WorkflowTransitionContext } from "./graph.js";
import {
    loadWorkflowTransitionRegistrationFromSnapshot,
    materializeWorkflowPackageArtifactSnapshot,
    type WorkflowPackageMaterialization,
} from "./package-loader.js";
import {
    workflowPackagesArtifactSessionId,
} from "./package-artifact.js";

export interface ResolvedWorkflowExecutionPlan {
    definitionId: string;
    manifest: CompiledWorkflowManifest;
}

export interface ExecuteWorkflowTransitionInput {
    definitionId: string;
    stateId: string;
    context: WorkflowTransitionContext;
}

export interface WorkflowDefinitionProvider {
    resolve(source: WorkflowDefinitionSource): Promise<ResolvedWorkflowExecutionPlan>;
    executeTransition(input: ExecuteWorkflowTransitionInput): Promise<WorkflowAdvanceDirective>;
}

function providerError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function requireRegisteredSource(
    source: WorkflowDefinitionSource,
): Extract<WorkflowDefinitionSource, { kind: "registered" }> {
    if (
        !source
        || source.kind !== "registered"
        || !source.definitionId.trim()
        || source.definitionId !== source.definitionId.trim()
    ) {
        throw providerError(
            "The persisted workflow definition provider requires a registered definition ID.",
            "WORKFLOW_DEFINITION_SOURCE_INVALID",
        );
    }
    return source;
}

export function requireCompatibleWorkflowDefinition(
    record: WorkflowDefinitionRecord | null,
    definitionId: string,
): WorkflowDefinitionRecord {
    if (!record) {
        throw providerError(
            `Workflow definition '${definitionId}' was not found.`,
            "WORKFLOW_DEFINITION_NOT_FOUND",
        );
    }
    if (
        record.compilerVersion !== WORKFLOW_COMPILER_VERSION
        || record.compiledManifest.compilerVersion !== WORKFLOW_COMPILER_VERSION
    ) {
        throw providerError(
            `Workflow definition '${definitionId}' uses unsupported compiler version '${record.compilerVersion}'.`,
            "WORKFLOW_COMPILER_VERSION_UNSUPPORTED",
        );
    }
    if (
        record.compiledManifest.graphId !== record.graphId
        || record.compiledManifest.packageSha256 !== record.packageSha256
    ) {
        throw providerError(
            `Workflow definition '${definitionId}' has inconsistent compiled identities.`,
            "WORKFLOW_DEFINITION_INVALID",
        );
    }
    if (
        !/^[a-f0-9]{64}$/.test(record.compiledSha256)
        || workflowCompiledManifestSha256(record.compiledManifest)
            !== record.compiledSha256
    ) {
        throw providerError(
            `Workflow definition '${definitionId}' compiled manifest does not match its registered identity.`,
            "WORKFLOW_COMPILED_MANIFEST_HASH_MISMATCH",
        );
    }
    return record;
}

function requireExecutableState(
    manifest: CompiledWorkflowManifest,
    stateId: string,
): CompiledWorkflowExecutableStateManifest {
    const state = manifest.states.find(candidate => candidate.id === stateId);
    if (!state || state.type === "terminal") {
        throw providerError(
            `Workflow state '${stateId}' is not executable.`,
            "WORKFLOW_STATE_NOT_EXECUTABLE",
        );
    }
    return state;
}

export class CmsWorkflowDefinitionProvider implements WorkflowDefinitionProvider {
    private readonly snapshots = new Map<string, Promise<WorkflowPackageMaterialization>>();
    private readonly records = new Map<string, Promise<WorkflowDefinitionRecord>>();

    constructor(
        private readonly catalog: Pick<SessionCatalog, "getRegisteredWorkflowDefinition">,
        private readonly artifactStore: ArtifactStore,
    ) {}

    async resolve(source: WorkflowDefinitionSource): Promise<ResolvedWorkflowExecutionPlan> {
        const registered = requireRegisteredSource(source);
        const record = await this.getDefinition(registered.definitionId);
        await this.getSnapshot(record);
        return {
            definitionId: record.definitionId,
            manifest: record.compiledManifest,
        };
    }

    async executeTransition(
        input: ExecuteWorkflowTransitionInput,
    ): Promise<WorkflowAdvanceDirective> {
        const record = await this.getDefinition(input.definitionId);
        const state = requireExecutableState(record.compiledManifest, input.stateId);
        if (input.context.currentStateId !== input.stateId) {
            throw providerError(
                `Workflow transition context does not match state '${input.stateId}'.`,
                "WORKFLOW_TRANSITION_CONTEXT_MISMATCH",
            );
        }
        const snapshot = await this.getSnapshot(record);
        const registration = await loadWorkflowTransitionRegistrationFromSnapshot(
            snapshot,
            state.transition.handler,
        );
        if (
            registration.moduleIdentity?.moduleSha256
                !== state.transition.handler.moduleSha256
            || registration.moduleIdentity?.packageSha256 !== record.packageSha256
            || registration.allowedTargets.length !== state.transition.allowedTargets.length
            || registration.allowedTargets.some(
                target => !state.transition.allowedTargets.includes(target),
            )
        ) {
            throw providerError(
                `Workflow state '${input.stateId}' transition identity does not match its registered package.`,
                "WORKFLOW_TRANSITION_IDENTITY_MISMATCH",
            );
        }
        return executeWorkflowTransitionRegistration({
            graphId: record.graphId,
            metadata: record.compiledManifest.metadata,
            configuration: record.compiledManifest.configuration,
            registration,
            context: input.context,
        });
    }

    private getDefinition(definitionId: string): Promise<WorkflowDefinitionRecord> {
        let pending = this.records.get(definitionId);
        if (!pending) {
            pending = this.catalog.getRegisteredWorkflowDefinition(definitionId)
                .then(record => requireCompatibleWorkflowDefinition(record, definitionId))
                .catch(error => {
                    this.records.delete(definitionId);
                    throw error;
                });
            this.records.set(definitionId, pending);
        }
        return pending;
    }

    private getSnapshot(record: WorkflowDefinitionRecord): Promise<WorkflowPackageMaterialization> {
        let pending = this.snapshots.get(record.packageSha256);
        if (!pending) {
            pending = this.artifactStore.downloadArtifact(
                workflowPackagesArtifactSessionId(),
                record.packageArtifactFilename,
            )
                .then(async artifact => {
                    const snapshot = await materializeWorkflowPackageArtifactSnapshot(
                        artifact.body,
                        record.packageSha256,
                    );
                    return {
                        root: snapshot.root,
                        packageSha256: snapshot.packageSha256,
                    };
                })
                .catch(error => {
                    this.snapshots.delete(record.packageSha256);
                    throw error;
                });
            this.snapshots.set(record.packageSha256, pending);
        }
        return pending;
    }
}
