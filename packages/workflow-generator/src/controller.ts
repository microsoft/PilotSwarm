import { randomUUID } from "node:crypto";
import {
    loadLifecycleStateMarkdown,
    parseLifecycleStateTransitions,
    validateLifecycleStateMachineSnapshot,
} from "pilotswarm-sdk";
import type {
    ContextTier,
    WorkflowDefinitionRow,
    WorkflowGeneratorRow,
    WorkflowRunJournalEntryRow,
    WorkflowRunRow,
    WorkflowRunSessionRow,
    WorkflowRunStateRunRow,
    LifecycleStateReader,
    LifecycleStateSource,
    LifecycleStateMachineSnapshot,
    ModelProviderRegistry,
    PilotSwarmClient,
    ReasoningEffort,
    SessionCatalog,
    SessionOwnerInfo,
    WorkflowComputeAffinity,
} from "pilotswarm-sdk";
import {
    effectiveWorkflowGeneratorLeaseSeconds,
    type SourceEvaluator,
} from "./providers.js";

export type WorkflowGeneratorStore = Pick<
    SessionCatalog,
    | "claimDueWorkflowGenerators"
    | "beginWorkflowGeneratorCycle"
    | "getWorkflowRun"
    | "getWorkflowDefinition"
    | "completeWorkflowGeneratorCycle"
    | "reconcileWorkflowGeneratorDiscoveries"
    | "listWorkflowRunSessions"
    | "listWorkflowRunStateRuns"
    | "listWorkflowRunJournal"
    | "prepareWorkflowRunStateRun"
>;

export type WorkflowRunInducerStore = Pick<
    SessionCatalog,
    | "claimWorkflowRunsForInduction"
    | "attachWorkflowRunSession"
    | "failWorkflowRunSession"
>;

export interface InitialSessionFactory {
    createInitialSession(input: {
        definition: WorkflowDefinitionRow;
        workflowRun: WorkflowRunRow;
        association: WorkflowRunSessionRow;
        executionAffinity: SessionOwnerInfo;
        onSessionCreated?: () => Promise<void>;
    }): Promise<void>;
    deleteInitialSession(sessionId: string, reason: string): Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function repoAffinityValue(value: unknown): string | undefined {
    const repo = stringValue(value)?.toLowerCase();
    if (!repo) return undefined;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(repo)) {
        throw new Error(`Unsupported repository affinity: ${repo}`);
    }
    return repo;
}

function reasoningEffortValue(value: unknown): ReasoningEffort | undefined {
    const normalized = stringValue(value);
    if (!normalized) return undefined;
    const allowed: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    if (!allowed.includes(normalized as ReasoningEffort)) {
        throw new Error(`Unsupported reasoning effort: ${normalized}`);
    }
    return normalized as ReasoningEffort;
}

function contextTierValue(value: unknown): ContextTier | undefined {
    const normalized = stringValue(value);
    if (!normalized) return undefined;
    if (normalized !== "default" && normalized !== "long_context") {
        throw new Error(`Unsupported context tier: ${normalized}`);
    }
    return normalized;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return value;
}

function waitForPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, intervalMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

function renderPrompt(template: string, workflowRun: WorkflowRunRow): string {
    return template
        .replaceAll("{workflowRun.key}", workflowRun.workflowRunKey)
        .replaceAll("{workflowRun.payload}", JSON.stringify(workflowRun.input, null, 2))
        .replaceAll("{workflowRun.id}", workflowRun.workflowRunId);
}

function lifecycleConfig(definition: WorkflowDefinitionRow): Record<string, unknown> {
    const root = object(definition.workflowDefinition);
    const nested = object(root.lifecycle);
    return Object.keys(nested).length > 0 ? nested : root;
}

function lifecycleSources(value: unknown): LifecycleStateSource[] {
    if (!Array.isArray(value)) return [];
    return value.map((source) => object(source) as unknown as LifecycleStateSource);
}

function lifecycleSnapshot(value: unknown): Readonly<LifecycleStateMachineSnapshot> | null {
    return value === undefined
        ? null
        : validateLifecycleStateMachineSnapshot(value);
}

function preparedStateRun(run: WorkflowRunStateRunRow | undefined): WorkflowRunStateRunRow | null {
    if (!run) return null;
    const snapshot = [
        run.stateOwner,
        run.sourceId,
        run.sourcePath,
        run.sourceCommit,
        run.markdownSha256,
        run.terminal,
    ];
    if (snapshot.every((value) => value === null)) return null;
    if (snapshot.some((value) => value === null)) {
        throw new Error(`WorkflowRun state run ${run.stateRunId} has an incomplete durable Markdown snapshot`);
    }
    return run;
}

function renderJournal(entries: readonly WorkflowRunJournalEntryRow[]): string {
    if (entries.length === 0) return "No previous state transitions.";
    return entries.map((entry) => {
        const outcome = entry.outcome ? ` via ${entry.outcome}` : "";
        return [
            `${entry.sequence}. ${entry.fromState} -> ${entry.toState}${outcome}`,
            `   Session: ${entry.sessionId}`,
            `   Summary: ${entry.summary}`,
        ].join("\n");
    }).join("\n");
}

function renderLifecyclePrompt(input: {
    workflowRun: WorkflowRunRow;
    markdown: string;
    journal: readonly WorkflowRunJournalEntryRow[];
    validationGates: readonly unknown[];
    terminal: boolean;
    outcomes: readonly { outcome: string; toState: string }[];
}): string {
    const completion = input.terminal
        ? [
            "When the state work is complete, call complete_state with a non-empty summary and omit outcome.",
            "The summary must preserve the outcome, evidence, durable identifiers or references, and enough detail for later lifecycle work to continue from this WorkflowRun.",
        ].join("\n")
        : [
            "When the state work is complete, call complete_state exactly once with:",
            "- outcome: one of the possible next states declared in the Markdown below",
            "- summary: a non-empty durable handoff for the next state",
            "The summary must preserve the outcome, evidence, durable identifiers or references, and enough detail for later lifecycle work to continue from this WorkflowRun.",
            `Allowed outcomes: ${input.outcomes.map((entry) => entry.outcome).join(", ")}`,
        ].join("\n");
    const reachableStates = new Set(
        input.terminal
            ? []
            : input.outcomes.map((entry) => entry.toState),
    );
    const validationGates = input.validationGates.filter((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const gate = value as Record<string, unknown>;
        return gate.type === "external_operation"
            && typeof gate.beforeState === "string"
            && reachableStates.has(gate.beforeState);
    });
    return [
        `Execute WorkflowRun ${input.workflowRun.workflowRunId} in state ${input.workflowRun.currentState}.`,
        "",
        "## WorkflowRun source record",
        `Key: ${input.workflowRun.workflowRunKey}`,
        "```json",
        JSON.stringify(input.workflowRun.input, null, 2),
        "```",
        "",
        "## Durable WorkflowRun journal",
        renderJournal(input.journal),
        "",
        "Treat the journal summaries as the durable handoff from prior states. "
            + "When a summary is insufficient, call read_workflow_run_source_session with its Session ID "
            + "to inspect the prior execution context.",
        "",
        "## Durable execution rules",
        "This state may resume in the same durable session after a wait or worker replacement. "
            + "Start platform-owned work only through start_external_operation. The infrastructure owns the operation ID, "
            + "correlation ID, and signal key; never invent or simulate them. Repeating the same call after resume returns "
            + "the existing operation instead of creating a duplicate.",
        "For a human decision, call ask_user. For a platform-owned external event, call system_wait with the exact signalKey "
            + "returned by start_external_operation. After resume, call get_external_operation and inspect its durable result "
            + "and evidence. Neither kind of wait advances the lifecycle state.",
        "",
        "## Required external-operation gates",
        validationGates.length > 0
            ? JSON.stringify(validationGates, null, 2)
            : "No external-operation gates apply to the reachable next states.",
        "",
        "## Current state instructions",
        input.markdown,
        "",
        "## Completion protocol",
        completion,
    ].join("\n");
}

export class PilotSwarmInitialSessionFactory implements InitialSessionFactory {
    constructor(
        private readonly client: PilotSwarmClient,
        private readonly lifecycle?: {
            store: Pick<
                SessionCatalog,
                | "grantSessionShare"
                | "listWorkflowRunJournal"
                | "listWorkflowRunStateRuns"
                | "prepareWorkflowRunStateRun"
            >;
            reader: LifecycleStateReader;
        },
        private readonly modelProviders?: Pick<ModelProviderRegistry, "normalize">,
    ) {}

    async createInitialSession(input: {
        definition: WorkflowDefinitionRow;
        workflowRun: WorkflowRunRow;
        association: WorkflowRunSessionRow;
        executionAffinity: SessionOwnerInfo;
        onSessionCreated?: () => Promise<void>;
    }): Promise<void> {
        const lifecycle = lifecycleConfig(input.definition);
        const sessionConfig = object(lifecycle.session);
        const effectiveConfig = object(input.workflowRun.effectiveConfig);
        const affinities = Object.keys(object(effectiveConfig.affinities)).length > 0
            ? object(effectiveConfig.affinities)
            : object(input.definition.affinities);
        const initialPrompt = stringValue(lifecycle.initialPrompt)
            ?? "Process Workflow Run {workflowRun.key}:\n{workflowRun.payload}";
        const sources = lifecycleSources(lifecycle.sources);
        const frozenStateMachine = lifecycleSnapshot(lifecycle.stateMachineSnapshot);
        let prompt = renderPrompt(initialPrompt, input.workflowRun);
        let lifecycleToolRequired = false;
        let stateOwner: "user" | "platform" | undefined;
        if (sources.length > 0 || frozenStateMachine) {
            if (!this.lifecycle) {
                throw new Error("Lifecycle state reader and catalog are required for lifecycle sources");
            }
            const stateRuns = input.association.stateRunId
                ? await this.lifecycle.store.listWorkflowRunStateRuns(input.workflowRun.workflowRunId)
                : [];
            const associatedRun = input.association.stateRunId
                ? stateRuns.find((run) => run.stateRunId === input.association.stateRunId)
                : undefined;
            if (input.association.stateRunId && !associatedRun) {
                throw new Error(
                    `WorkflowRun state run ${input.association.stateRunId} was not found for WorkflowRun ${input.workflowRun.workflowRunId}`,
                );
            }
            if (associatedRun
                && (associatedRun.workflowRunId !== input.workflowRun.workflowRunId
                    || associatedRun.workflowDefinitionId !== input.workflowRun.workflowDefinitionId
                    || associatedRun.stateName !== input.workflowRun.currentState
                    || associatedRun.stateRevision !== input.workflowRun.stateRevision)) {
                throw new Error(
                    `WorkflowRun state run ${associatedRun.stateRunId} does not match WorkflowRun ${input.workflowRun.workflowRunId} revision ${input.workflowRun.stateRevision}`,
                );
            }
            const preparedRun = preparedStateRun(associatedRun);
            const frozenState = frozenStateMachine?.states[input.workflowRun.currentState];
            if (frozenStateMachine && !frozenState) {
                throw new Error(
                    `Frozen lifecycle ${frozenStateMachine.lifecycleName} does not contain state ${input.workflowRun.currentState}`,
                );
            }
            const loaded = frozenState
                ? {
                    lifecycleName: frozenStateMachine!.lifecycleName,
                    state: input.workflowRun.currentState,
                    owner: frozenState.owner,
                    source: {
                        ...(frozenStateMachine!.sources.find(
                            (candidate) => candidate.sourceId === frozenState.sourceId,
                        ) ?? {
                            sourceId: frozenState.sourceId,
                            owner: frozenState.owner,
                            filePrefix: frozenStateMachine!.lifecycleName,
                        }),
                        requestedRef: undefined,
                        resolvedCommit: frozenState.sourceCommit,
                    },
                    sourcePath: frozenState.sourcePath,
                    markdown: frozenState.markdown,
                    sha256: frozenState.markdownSha256,
                }
                : await (() => {
                    const sourcesForRead = preparedRun
                        ? (() => {
                            const source = sources.find((candidate) => candidate.sourceId === preparedRun.sourceId);
                            if (!source) {
                                throw new Error(
                                    `Prepared lifecycle source ${preparedRun.sourceId} is not present in definition ${input.definition.workflowDefinitionId}`,
                                );
                            }
                            return [{
                                ...source,
                                requestedRef: undefined,
                                resolvedCommit: preparedRun.sourceCommit!,
                            }];
                        })()
                        : sources;
                    return loadLifecycleStateMarkdown({
                        lifecycleName: stringValue(lifecycle.name) ?? input.definition.name,
                        state: input.workflowRun.currentState,
                        sources: sourcesForRead,
                        reader: this.lifecycle!.reader,
                        resolveRequestedRefs: !preparedRun,
                    });
                })();
            if (preparedRun) {
                if (loaded.owner !== preparedRun.stateOwner
                    || loaded.sourcePath !== preparedRun.sourcePath
                    || loaded.sha256 !== preparedRun.markdownSha256) {
                    throw new Error(
                        `Lifecycle Markdown no longer matches durable snapshot for state run ${preparedRun.stateRunId}`,
                    );
                }
            }

            const transitions = frozenState
                ? {
                    outcomes: frozenState.outcomes,
                    terminal: frozenState.terminal,
                }
                : preparedRun
                ? {
                    outcomes: preparedRun.allowedOutcomes,
                    terminal: preparedRun.terminal!,
                }
                : parseLifecycleStateTransitions(loaded.markdown);
            const journal = await this.lifecycle.store.listWorkflowRunJournal(input.workflowRun.workflowRunId);
            const sourceCommit = loaded.source.resolvedCommit;
            if (!sourceCommit) {
                throw new Error(`Lifecycle source ${loaded.source.sourceId} did not resolve to a commit`);
            }
            await this.lifecycle.store.prepareWorkflowRunStateRun({
                sessionId: input.association.sessionId,
                expectedState: input.workflowRun.currentState,
                expectedRevision: input.workflowRun.stateRevision,
                stateOwner: loaded.owner,
                sourceId: loaded.source.sourceId,
                sourcePath: loaded.sourcePath,
                sourceCommit,
                markdownSha256: loaded.sha256,
                allowedOutcomes: transitions.outcomes.map((entry) => ({ ...entry })),
                terminal: transitions.terminal,
            });
            stateOwner = loaded.owner;
            prompt = renderLifecyclePrompt({
                workflowRun: input.workflowRun,
                markdown: loaded.markdown,
                journal,
                validationGates: input.definition.validationGates,
                terminal: transitions.terminal,
                outcomes: transitions.outcomes,
            });
            lifecycleToolRequired = true;
        }
        const configuredToolNames = Array.isArray(sessionConfig.toolNames)
            ? sessionConfig.toolNames.filter((value): value is string => typeof value === "string")
            : [];
        const toolNames = lifecycleToolRequired
            ? [...new Set([
                ...configuredToolNames,
                "read_workflow_run_source_session",
                "start_external_operation",
                "get_external_operation",
                "complete_state",
            ])]
            : configuredToolNames;
        const requireOwnerAffinity = input.definition.sessionComputeAffinity === "devbox";
        const configuredModel = stringValue(sessionConfig.model);
        const model = configuredModel && !configuredModel.includes(":")
            ? this.modelProviders?.normalize(configuredModel)
            : configuredModel;
        if (configuredModel && !model) {
            throw new Error(
                `Workflow Definition model ${JSON.stringify(configuredModel)} is not available in the controller model catalog`,
            );
        }
        const session = await this.client.createSession({
            sessionId: input.association.sessionId,
            model,
            reasoningEffort: reasoningEffortValue(sessionConfig.reasoningEffort),
            contextTier: contextTierValue(sessionConfig.contextTier),
            systemMessage: stringValue(sessionConfig.systemMessage),
            agentId: stringValue(sessionConfig.agentName),
            boundAgentName: stringValue(sessionConfig.agentName),
            promptLayering: stringValue(sessionConfig.agentName) ? { kind: "app-agent" } : undefined,
            repo: repoAffinityValue(sessionConfig.repo) ?? repoAffinityValue(affinities.repo),
            gitRef: stringValue(sessionConfig.gitRef) ?? stringValue(affinities.gitRef),
            toolNames: toolNames.length > 0 ? toolNames : undefined,
            owner: requireOwnerAffinity ? input.executionAffinity : input.workflowRun.owner,
            requireOwnerAffinity,
        });
        if (stateOwner === "user"
            && !requireOwnerAffinity
            && (input.executionAffinity.provider !== input.workflowRun.owner.provider
                || input.executionAffinity.subject !== input.workflowRun.owner.subject)) {
            await this.lifecycle!.store.grantSessionShare(
                input.association.sessionId,
                input.executionAffinity,
                "write",
                input.workflowRun.owner,
            );
        }
        await input.onSessionCreated?.();
        await session.send(prompt, {
            bootstrap: true,
            clientMessageIds: [`workflow-generator:${input.workflowRun.workflowRunId}:state:${input.workflowRun.stateRevision}`],
        });
    }

    async deleteInitialSession(sessionId: string): Promise<void> {
        await this.client.deleteSession(sessionId);
    }
}

export interface WorkflowGeneratorControllerOptions {
    store: WorkflowGeneratorStore;
    evaluators: Map<string, SourceEvaluator>;
    workerId?: string;
    pollIntervalMs?: number;
    claimLimit?: number;
    leaseSeconds?: number;
    controllerCompute?: WorkflowComputeAffinity;
    logger?: Pick<Console, "info" | "error" | "warn">;
}

export class WorkflowGeneratorController {
    private readonly store: WorkflowGeneratorStore;
    private readonly evaluators: Map<string, SourceEvaluator>;
    private readonly workerId: string;
    private readonly pollIntervalMs: number;
    private readonly claimLimit: number;
    private readonly leaseSeconds: number;
    private readonly controllerCompute: WorkflowComputeAffinity;
    private readonly logger: Pick<Console, "info" | "error" | "warn">;

    constructor(options: WorkflowGeneratorControllerOptions) {
        this.store = options.store;
        this.evaluators = options.evaluators;
        this.workerId = options.workerId ?? `workflow-generator-${randomUUID()}`;
        this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 15_000, "pollIntervalMs");
        this.claimLimit = positiveInteger(options.claimLimit ?? 10, "claimLimit");
        this.leaseSeconds = effectiveWorkflowGeneratorLeaseSeconds(
            options.leaseSeconds ?? 300,
            "leaseSeconds",
        );
        this.controllerCompute = options.controllerCompute ?? "cluster";
        this.logger = options.logger ?? console;
    }

    async runOnce(signal?: AbortSignal): Promise<number> {
        const generators = await this.store.claimDueWorkflowGenerators(
            this.workerId,
            this.claimLimit,
            this.leaseSeconds,
            this.controllerCompute,
        );
        this.logger.info(`[workflow-generator] poll claimed=${generators.length}`);
        await Promise.all(generators.map(async (generator) => {
            try {
                await this.processGenerator(generator, signal);
            } catch (error) {
                this.logger.error(`[workflow-generator] ${generator.workflowGeneratorId} failed`, error);
            }
        }));
        return generators.length;
    }

    async run(signal?: AbortSignal): Promise<void> {
        while (!signal?.aborted) {
            try {
                await this.runOnce(signal);
            } catch (error) {
                this.logger.error("[workflow-generator] polling failed", error);
            }
            if (signal?.aborted) break;
            await waitForPoll(this.pollIntervalMs, signal);
        }
    }

    private async processGenerator(
        generator: WorkflowGeneratorRow,
        signal?: AbortSignal,
    ): Promise<void> {
        const { cycle, definition } = await this.store.beginWorkflowGeneratorCycle(
            generator.workflowGeneratorId,
            this.workerId,
        );
        this.logger.info(
            `[workflow-generator] ${generator.name}: evaluating source=${generator.sourceType} cycle=${cycle.cycleId}`,
        );
        let discoveredCount = 0;
        let createdCount = 0;
        try {
            if (!generator.sourceType) throw new Error("WorkflowGenerator has no source provider");
            const evaluator = this.evaluators.get(generator.sourceType);
            if (!evaluator) throw new Error(`No evaluator configured for ${generator.sourceType}`);
            const evaluation = await evaluator.evaluate({
                generator,
                definition,
                watermark: cycle.watermarkBefore,
                signal,
            });
            discoveredCount = evaluation.discoveries.length;
            const maxItems = Number(definition.guardrails.maxItemsPerCycle ?? 0);
            if (Number.isFinite(maxItems) && maxItems > 0 && discoveredCount > maxItems) {
                throw new Error(`Provider returned ${discoveredCount} items, exceeding maxItemsPerCycle=${maxItems}`);
            }

            const reconciledWorkflowRuns = await this.store.reconcileWorkflowGeneratorDiscoveries(
                cycle.cycleId,
                evaluation.discoveries,
            );
            createdCount = reconciledWorkflowRuns.filter((workflowRun) => workflowRun.created).length;
            await this.store.completeWorkflowGeneratorCycle({
                cycleId: cycle.cycleId,
                workerId: this.workerId,
                status: "succeeded",
                watermark: evaluation.watermark,
                discoveredCount,
                createdCount,
            });
            this.logger.info(
                `[workflow-generator] ${generator.name}: discovered=${discoveredCount} created=${createdCount}`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.store.completeWorkflowGeneratorCycle({
                cycleId: cycle.cycleId,
                workerId: this.workerId,
                status: "failed",
                discoveredCount,
                createdCount,
                error: message,
            });
            throw error;
        }
    }
}
