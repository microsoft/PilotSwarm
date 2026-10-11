export interface WorkflowProviderExecutionContext {
    workflowSessionId: string;
    graphId: string;
    stateId: string;
    executionSequence: number;
    workflowInputs: Readonly<Record<string, unknown>>;
}

export interface WorkflowActionRequest extends WorkflowProviderExecutionContext {
    provider: string;
    operation: string;
    input: unknown;
}

export interface WorkflowObservedConditionRequest
    extends WorkflowProviderExecutionContext {
    provider: string;
    operation: unknown;
    conditions: unknown;
    observationAttempt: number;
}

export interface WorkflowProviderResult {
    outcome: string;
    output: unknown;
}

export type WorkflowObservationResult =
    | {
        status: "pending";
        retryAfterMs?: number;
        output?: unknown;
    }
    | ({
        status: "completed";
    } & WorkflowProviderResult);

export type WorkflowActionHandler = (
    request: WorkflowActionRequest,
) => Promise<WorkflowProviderResult> | WorkflowProviderResult;

export type WorkflowObservedConditionHandler = (
    request: WorkflowObservedConditionRequest,
) => Promise<WorkflowObservationResult> | WorkflowObservationResult;

function providerError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function providerId(value: string): string {
    const normalized = value?.trim();
    if (!normalized) {
        throw providerError(
            "Workflow state provider id is required.",
            "WORKFLOW_STATE_PROVIDER_INVALID",
        );
    }
    return normalized;
}

export class WorkflowStateProviderRegistry {
    private readonly actionHandlers = new Map<string, WorkflowActionHandler>();
    private readonly observedConditionHandlers =
        new Map<string, WorkflowObservedConditionHandler>();

    registerAction(provider: string, handler: WorkflowActionHandler): this {
        const id = providerId(provider);
        if (typeof handler !== "function") {
            throw providerError(
                `Workflow action provider '${id}' must be a function.`,
                "WORKFLOW_STATE_PROVIDER_INVALID",
            );
        }
        if (this.actionHandlers.has(id)) {
            throw providerError(
                `Workflow action provider '${id}' is already registered.`,
                "WORKFLOW_STATE_PROVIDER_ALREADY_REGISTERED",
            );
        }
        this.actionHandlers.set(id, handler);
        return this;
    }

    registerObservedCondition(
        provider: string,
        handler: WorkflowObservedConditionHandler,
    ): this {
        const id = providerId(provider);
        if (typeof handler !== "function") {
            throw providerError(
                `Workflow observed-condition provider '${id}' must be a function.`,
                "WORKFLOW_STATE_PROVIDER_INVALID",
            );
        }
        if (this.observedConditionHandlers.has(id)) {
            throw providerError(
                `Workflow observed-condition provider '${id}' is already registered.`,
                "WORKFLOW_STATE_PROVIDER_ALREADY_REGISTERED",
            );
        }
        this.observedConditionHandlers.set(id, handler);
        return this;
    }

    executeAction(request: WorkflowActionRequest): Promise<WorkflowProviderResult> {
        const handler = this.actionHandlers.get(providerId(request.provider));
        if (!handler) {
            throw providerError(
                `Workflow action provider '${request.provider}' is not registered.`,
                "WORKFLOW_ACTION_PROVIDER_NOT_REGISTERED",
            );
        }
        return Promise.resolve(handler(request));
    }

    observeCondition(
        request: WorkflowObservedConditionRequest,
    ): Promise<WorkflowObservationResult> {
        const handler = this.observedConditionHandlers.get(
            providerId(request.provider),
        );
        if (!handler) {
            throw providerError(
                `Workflow observed-condition provider '${request.provider}' is not registered.`,
                "WORKFLOW_OBSERVED_CONDITION_PROVIDER_NOT_REGISTERED",
            );
        }
        return Promise.resolve(handler(request));
    }
}
