import { parseDocument } from "yaml";
import { workflowCanonicalJsonSha256 } from "./admission.js";
import type { WorkflowDefinitionSource } from "../types.js";
import {
    registerInMemoryWorkflowGraph,
    type InMemoryWorkflowGraph,
    type WorkflowExecutionRecord,
    type WorkflowStateExecutionResult,
    type WorkflowTransitionContext,
} from "./graph.js";

const SUPPORTED_API_VERSION = "pilotswarm.dev/v1alpha1";
const SUPPORTED_KIND = "Workflow";
const TERMINAL_OUTCOMES = new Set(["succeeded", "blocked", "failed", "cancelled"]);
const EXACT_EXPRESSION = /^\$\{([^{}]+)\}$/;

export const WORKFLOW_COMPILER_VERSION = "v1alpha1-4";

type JsonObject = Record<string, unknown>;

export interface WorkflowPackageMetadata {
    name: string;
    version: string;
}

export interface WorkflowTransitionHandlerContext {
    graphId: string;
    metadata: Readonly<WorkflowPackageMetadata>;
    configuration: Readonly<JsonObject>;
    workflowInputs: Readonly<JsonObject>;
    currentStateId: string;
    stateOutcome: string;
    stateOutput: unknown;
    completion: Readonly<{
        feedback?: unknown;
    }>;
    latestStateOutputs: Readonly<Record<string, WorkflowStateExecutionResult>>;
    executionHistory: readonly WorkflowExecutionRecord[];
}

export interface WorkflowAdvanceDirective {
    kind: "advance";
    target: string;
}

export interface WorkflowResumeProducerDirective {
    kind: "resume-producer";
    feedback: unknown;
}

export type WorkflowTransitionDirective =
    | WorkflowAdvanceDirective
    | WorkflowResumeProducerDirective;

export type WorkflowTransitionHandler = (
    context: WorkflowTransitionHandlerContext,
) => WorkflowTransitionDirective;

export interface WorkflowTransitionReference {
    module: string;
    export: string;
}

export interface WorkflowTransitionModuleIdentity extends WorkflowTransitionReference {
    moduleSha256: string;
    packageSha256: string;
}

export interface WorkflowTransitionRegistration {
    allowedTargets: readonly string[];
    handler: WorkflowTransitionHandler;
    moduleIdentity?: Readonly<WorkflowTransitionModuleIdentity>;
}

export interface CompiledWorkflowTransitionHandlerManifest extends WorkflowTransitionReference {
    moduleSha256?: string;
    packageSha256?: string;
}

export interface CompiledWorkflowTransitionState {
    id: string;
    completion: {
        outcomes: readonly string[];
    };
    transition: {
        handler: Readonly<CompiledWorkflowTransitionHandlerManifest>;
        allowedTargets: readonly string[];
    };
}

export interface CompiledWorkflowAgentStateManifest
    extends CompiledWorkflowTransitionState {
    type: "agent";
    agent: string;
    input: unknown;
    resultSchema: string;
    completion: {
        mode: "one-shot";
        outcomes: readonly string[];
    };
}

export interface CompiledWorkflowQuestionStateManifest
    extends CompiledWorkflowTransitionState {
    type: "question";
    prompt: unknown;
    context: unknown;
    authorization: Readonly<{
        mode: "session-write";
    }>;
}

export interface CompiledWorkflowActionStateManifest
    extends CompiledWorkflowTransitionState {
    type: "action";
    provider: string;
    operation: string;
    input: unknown;
}

export interface CompiledWorkflowObservedConditionStateManifest
    extends CompiledWorkflowTransitionState {
    type: "observed-condition";
    provider: string;
    operation: unknown;
    conditions: unknown;
    pollIntervalMs: number;
}

export interface CompiledWorkflowTerminalStateManifest {
    id: string;
    type: "terminal";
    outcome: "succeeded" | "blocked" | "failed" | "cancelled";
    summary: string;
    hasOutput: boolean;
    output?: unknown;
}

export type CompiledWorkflowStateManifest =
    | CompiledWorkflowAgentStateManifest
    | CompiledWorkflowQuestionStateManifest
    | CompiledWorkflowActionStateManifest
    | CompiledWorkflowObservedConditionStateManifest
    | CompiledWorkflowTerminalStateManifest;

export type CompiledWorkflowExecutableStateManifest = Exclude<
    CompiledWorkflowStateManifest,
    CompiledWorkflowTerminalStateManifest
>;

export interface CompiledWorkflowIdentityManifest {
    primaryKey: readonly string[];
}

export interface CompiledWorkflowManifest {
    compilerVersion: typeof WORKFLOW_COMPILER_VERSION;
    apiVersion: typeof SUPPORTED_API_VERSION;
    kind: typeof SUPPORTED_KIND;
    graphId: string;
    packageSha256?: string;
    metadata: Readonly<WorkflowPackageMetadata>;
    inputSchema: Readonly<JsonObject>;
    identity?: Readonly<CompiledWorkflowIdentityManifest>;
    configuration: Readonly<JsonObject>;
    initialState: string;
    states: readonly CompiledWorkflowStateManifest[];
}

export interface CompiledWorkflowYaml {
    graph: InMemoryWorkflowGraph;
    manifest: Readonly<CompiledWorkflowManifest>;
    metadata: Readonly<WorkflowPackageMetadata>;
    inputSchema: Readonly<JsonObject>;
    configuration: Readonly<JsonObject>;
}

export function workflowCompiledManifestSha256(
    manifest: CompiledWorkflowManifest,
): string {
    return workflowCanonicalJsonSha256(manifest);
}

function compilerError(message: string, code = "WORKFLOW_COMPILER_INVALID"): Error {
    return Object.assign(new Error(message), { code });
}

function isObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): JsonObject {
    if (!isObject(value)) {
        throw compilerError(`${path} must be an object.`);
    }
    return value;
}

function requireString(value: unknown, path: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw compilerError(`${path} must be a non-empty string.`);
    }
    return value.trim();
}

function requireStringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw compilerError(`${path} must contain at least one string.`);
    }
    const values = value.map((item, index) => requireString(item, `${path}[${index}]`));
    if (new Set(values).size !== values.length) {
        throw compilerError(`${path} must not contain duplicate values.`);
    }
    return values;
}

function compileWorkflowInputSchema(value: unknown): JsonObject {
    const schema = value == null ? {} : requireObject(value, "inputs");
    for (const [name, rawDeclaration] of Object.entries(schema)) {
        const declaration = requireObject(rawDeclaration, `inputs.${name}`);
        const type = requireString(declaration.type, `inputs.${name}.type`);
        if (!["string", "number", "integer", "boolean", "object", "array"].includes(type)) {
            throw compilerError(
                `inputs.${name}.type '${type}' is not supported.`,
                "WORKFLOW_INPUT_SCHEMA_INVALID",
            );
        }
        if (
            declaration.required !== undefined
            && typeof declaration.required !== "boolean"
        ) {
            throw compilerError(
                `inputs.${name}.required must be a boolean when provided.`,
                "WORKFLOW_INPUT_SCHEMA_INVALID",
            );
        }
    }
    return schema;
}

function compileWorkflowIdentity(
    value: unknown,
    inputSchema: JsonObject,
): CompiledWorkflowIdentityManifest | undefined {
    if (value == null) return undefined;
    const identity = requireObject(value, "identity");
    const primaryKey = requireStringArray(identity.primaryKey, "identity.primaryKey");
    for (const [index, expression] of primaryKey.entries()) {
        const inputName = Object.keys(inputSchema)
            .find(name => expression === `inputs.${name}`);
        if (inputName === undefined) {
            throw compilerError(
                `identity.primaryKey[${index}] must reference one top-level input as inputs.<name>.`,
                "WORKFLOW_PRIMARY_KEY_INVALID",
            );
        }
        const declaration = requireObject(
            inputSchema[inputName],
            `inputs.${inputName}`,
        );
        if (declaration.required !== true) {
            throw compilerError(
                `Primary-key input '${inputName}' must be required.`,
                "WORKFLOW_PRIMARY_KEY_INVALID",
            );
        }
        const type = requireString(declaration.type, `inputs.${inputName}.type`);
        if (!["string", "number", "integer", "boolean"].includes(type)) {
            throw compilerError(
                `Primary-key input '${inputName}' must use a scalar type.`,
                "WORKFLOW_PRIMARY_KEY_INVALID",
            );
        }
    }
    return { primaryKey };
}

function requireTransitionReference(
    value: unknown,
    path: string,
): WorkflowTransitionReference {
    const reference = requireObject(value, path);
    return {
        module: requireString(reference.module, `${path}.module`),
        export: requireString(reference.export, `${path}.export`),
    };
}

function transitionReferenceKey(reference: WorkflowTransitionReference): string {
    return `${reference.module}#${reference.export}`;
}

function transitionReferenceLabel(reference: WorkflowTransitionReference): string {
    return `'${reference.module}' export '${reference.export}'`;
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value as JsonObject)) {
        deepFreeze(nested);
    }
    return value;
}

function readPath(root: unknown, segments: readonly string[], expression: string): unknown {
    let current = root;
    for (const segment of segments) {
        if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
            throw compilerError(
                `Workflow expression '\${${expression}}' could not resolve '${segment}'.`,
                "WORKFLOW_EXPRESSION_UNRESOLVED",
            );
        }
        current = current[segment];
    }
    return current;
}

function parseExpression(value: string, path: string): string[] | null {
    const match = EXACT_EXPRESSION.exec(value);
    if (!match) {
        if (value.includes("${")) {
            throw compilerError(
                `${path} uses an embedded workflow expression; v1alpha1 supports only values that are exactly one expression.`,
                "WORKFLOW_EXPRESSION_UNSUPPORTED",
            );
        }
        return null;
    }
    const segments = match[1].split(".").map(segment => segment.trim()).filter(Boolean);
    if (segments.length < 2 || !["inputs", "configuration", "states"].includes(segments[0])) {
        throw compilerError(
            `${path} expression '${value}' must start with inputs, configuration, or states.`,
            "WORKFLOW_EXPRESSION_UNSUPPORTED",
        );
    }
    if (segments[0] === "states" && (segments.length < 3 || segments[2] !== "result")) {
        throw compilerError(
            `${path} state expression '${value}' must use states.<stateId>.result.`,
            "WORKFLOW_EXPRESSION_UNSUPPORTED",
        );
    }
    return segments;
}

function validateTemplate(value: unknown, path: string, stateIds: ReadonlySet<string>): void {
    if (typeof value === "string") {
        const segments = parseExpression(value, path);
        if (segments?.[0] === "states" && !stateIds.has(segments[1])) {
            throw compilerError(`${path} references unknown workflow state '${segments[1]}'.`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => validateTemplate(item, `${path}[${index}]`, stateIds));
        return;
    }
    if (isObject(value)) {
        for (const [key, nested] of Object.entries(value)) {
            validateTemplate(nested, `${path}.${key}`, stateIds);
        }
    }
}

export function resolveWorkflowTemplate(
    value: unknown,
    path: string,
    context: {
        inputs: Readonly<JsonObject>;
        configuration: Readonly<JsonObject>;
        latestStateOutputs: Readonly<Record<string, WorkflowStateExecutionResult>>;
    },
): unknown {
    if (typeof value === "string") {
        const segments = parseExpression(value, path);
        if (!segments) return value;
        const expression = segments.join(".");
        if (segments[0] === "inputs") {
            return readPath(context.inputs, segments.slice(1), expression);
        }
        if (segments[0] === "configuration") {
            return readPath(context.configuration, segments.slice(1), expression);
        }
        const stateResult = context.latestStateOutputs[segments[1]];
        if (!stateResult) {
            throw compilerError(
                `Workflow expression '\${${expression}}' references state '${segments[1]}' before it has produced a result.`,
                "WORKFLOW_EXPRESSION_UNRESOLVED",
            );
        }
        return readPath(
            { result: stateResult.output },
            segments.slice(2),
            expression,
        );
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => resolveWorkflowTemplate(item, `${path}[${index}]`, context));
    }
    if (isObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [
                key,
                resolveWorkflowTemplate(nested, `${path}.${key}`, context),
            ]),
        );
    }
    return value;
}

export function executeWorkflowTransitionRegistration(input: {
    graphId: string;
    metadata: WorkflowPackageMetadata;
    configuration: JsonObject;
    registration: WorkflowTransitionRegistration;
    context: WorkflowTransitionContext;
}): WorkflowAdvanceDirective {
    const directive = input.registration.handler(deepFreeze({
        graphId: input.graphId,
        metadata: { ...input.metadata },
        configuration: input.configuration,
        workflowInputs: input.context.workflowInputs,
        currentStateId: input.context.currentStateId,
        stateOutcome: input.context.stateOutcome,
        stateOutput: input.context.stateOutput,
        completion: {},
        latestStateOutputs: input.context.latestStateOutputs,
        executionHistory: input.context.executionHistory,
    }));
    if (
        directive
        && typeof (directive as unknown as PromiseLike<unknown>).then === "function"
    ) {
        throw compilerError(
            `Transition handler for state '${input.context.currentStateId}' returned a promise; transition handlers must be synchronous.`,
            "WORKFLOW_TRANSITION_ASYNC",
        );
    }
    if (!isObject(directive) || typeof directive.kind !== "string") {
        throw compilerError(
            `Transition handler for state '${input.context.currentStateId}' must return a transition directive.`,
            "WORKFLOW_TRANSITION_RESULT_INVALID",
        );
    }
    if (directive.kind === "resume-producer") {
        throw compilerError(
            `Transition handler for state '${input.context.currentStateId}' returned resume-producer, which is not supported for one-shot states.`,
            "WORKFLOW_TRANSITION_DIRECTIVE_UNSUPPORTED",
        );
    }
    if (directive.kind !== "advance") {
        throw compilerError(
            `Transition handler for state '${input.context.currentStateId}' returned unknown directive '${directive.kind}'.`,
            "WORKFLOW_TRANSITION_RESULT_INVALID",
        );
    }
    return {
        kind: "advance",
        target: requireString(
            directive.target,
            `Transition handler for state '${input.context.currentStateId}' advance target`,
        ),
    };
}

function transitionFromRegistration(input: {
    graphId: string;
    metadata: WorkflowPackageMetadata;
    configuration: JsonObject;
    registration: WorkflowTransitionRegistration;
}): (context: WorkflowTransitionContext) => string {
    return context => executeWorkflowTransitionRegistration({
        ...input,
        context,
    }).target;
}

export class WorkflowTransitionRegistry {
    private readonly registrations = new Map<string, WorkflowTransitionRegistration>();

    register(
        referenceValue: WorkflowTransitionReference,
        registration: WorkflowTransitionRegistration,
    ): this {
        const reference = requireTransitionReference(
            referenceValue,
            "Transition handler reference",
        );
        const key = transitionReferenceKey(reference);
        const label = transitionReferenceLabel(reference);
        if (!registration || typeof registration.handler !== "function") {
            throw compilerError(
                `Transition handler ${label} must provide a handler function.`,
                "WORKFLOW_TRANSITION_HANDLER_INVALID",
            );
        }
        const allowedTargets = requireStringArray(
            registration.allowedTargets,
            `Transition handler ${label} allowedTargets`,
        );
        if (this.registrations.has(key)) {
            throw compilerError(
                `Transition handler ${label} is already registered.`,
                "WORKFLOW_TRANSITION_HANDLER_ALREADY_REGISTERED",
            );
        }
        if (
            registration.moduleIdentity
            && (
                registration.moduleIdentity.module !== reference.module
                || registration.moduleIdentity.export !== reference.export
            )
        ) {
            throw compilerError(
                `Transition handler ${label} module identity does not match its reference.`,
                "WORKFLOW_TRANSITION_IDENTITY_INVALID",
            );
        }
        this.registrations.set(key, deepFreeze({
            allowedTargets: [...allowedTargets],
            handler: registration.handler,
            ...(registration.moduleIdentity
                ? { moduleIdentity: { ...registration.moduleIdentity } }
                : {}),
        }));
        return this;
    }

    resolve(referenceValue: WorkflowTransitionReference): WorkflowTransitionRegistration {
        const reference = requireTransitionReference(
            referenceValue,
            "Transition handler reference",
        );
        const key = transitionReferenceKey(reference);
        const registration = this.registrations.get(key);
        if (!registration) {
            throw compilerError(
                `Transition handler ${transitionReferenceLabel(reference)} is not registered.`,
                "WORKFLOW_TRANSITION_HANDLER_NOT_REGISTERED",
            );
        }
        return registration;
    }
}

export function compileWorkflowYaml(
    yaml: string,
    options: {
        transitions: WorkflowTransitionRegistry;
        packageSha256?: string;
    },
): CompiledWorkflowYaml {
    if (typeof yaml !== "string" || yaml.trim().length === 0) {
        throw compilerError("Workflow YAML must be a non-empty string.");
    }
    if (!(options?.transitions instanceof WorkflowTransitionRegistry)) {
        throw compilerError("Workflow compilation requires a transition registry.");
    }

    const document = parseDocument(yaml, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
    });
    if (document.errors.length > 0) {
        throw compilerError(
            `Workflow YAML could not be parsed: ${document.errors.map(error => error.message).join("; ")}`,
            "WORKFLOW_YAML_INVALID",
        );
    }
    const root = requireObject(document.toJS({ maxAliasCount: 50 }), "Workflow document");
    const apiVersion = requireString(root.apiVersion, "apiVersion");
    if (apiVersion !== SUPPORTED_API_VERSION) {
        throw compilerError(`Unsupported workflow apiVersion '${apiVersion}'.`);
    }
    const kind = requireString(root.kind, "kind");
    if (kind !== SUPPORTED_KIND) {
        throw compilerError(`Unsupported workflow kind '${kind}'.`);
    }

    const metadataValue = requireObject(root.metadata, "metadata");
    const metadata: WorkflowPackageMetadata = {
        name: requireString(metadataValue.name, "metadata.name"),
        version: requireString(metadataValue.version, "metadata.version"),
    };
    const graphId = `${metadata.name}@${metadata.version}`;
    const inputSchema = compileWorkflowInputSchema(root.inputs);
    const identity = compileWorkflowIdentity(root.identity, inputSchema);
    const configuration = root.configuration == null
        ? {}
        : requireObject(root.configuration, "configuration");
    const initialState = requireString(root.initial, "initial");
    const stateDocuments = requireObject(root.states, "states");
    const stateIds = new Set(Object.keys(stateDocuments));
    if (stateIds.size === 0) {
        throw compilerError("states must declare at least one workflow state.");
    }
    if (!stateIds.has(initialState)) {
        throw compilerError(`Initial workflow state '${initialState}' does not exist.`);
    }

    const states: Record<string, InMemoryWorkflowGraph["states"][string]> =
        Object.create(null);
    const stateManifests: CompiledWorkflowStateManifest[] = [];
    for (const [stateId, rawState] of Object.entries(stateDocuments)) {
        const path = `states.${stateId}`;
        const state = requireObject(rawState, path);
        const type = requireString(state.type, `${path}.type`);

        if (type === "terminal") {
            const outcome = requireString(state.outcome, `${path}.outcome`);
            if (!TERMINAL_OUTCOMES.has(outcome)) {
                throw compilerError(`${path}.outcome '${outcome}' is not a supported terminal outcome.`);
            }
            const outputTemplate = state.output;
            validateTemplate(outputTemplate, `${path}.output`, stateIds);
            const summary = typeof state.summary === "string" && state.summary.trim()
                ? state.summary.trim()
                : `Workflow '${metadata.name}' completed with outcome '${outcome}'.`;
            states[stateId] = {
                type: "terminal",
                outcome: outcome as "succeeded" | "blocked" | "failed" | "cancelled",
                summary,
                ...(Object.prototype.hasOwnProperty.call(state, "output")
                    ? {
                        result: context => resolveWorkflowTemplate(
                            outputTemplate,
                            `${path}.output`,
                            {
                                inputs: context.workflowInputs,
                                configuration,
                                latestStateOutputs: context.latestStateOutputs,
                            },
                        ),
                    }
                    : {}),
            };
            stateManifests.push({
                id: stateId,
                type: "terminal",
                outcome: outcome as "succeeded" | "blocked" | "failed" | "cancelled",
                summary,
                hasOutput: Object.prototype.hasOwnProperty.call(state, "output"),
                ...(Object.prototype.hasOwnProperty.call(state, "output")
                    ? { output: outputTemplate }
                    : {}),
            });
            continue;
        }

        if (state.next != null || state.transitions != null || state.events != null) {
            throw compilerError(
                `${path} uses inline transition syntax; declare transition.handler instead.`,
                "WORKFLOW_INLINE_TRANSITION_UNSUPPORTED",
            );
        }

        if (type === "question" || type === "action" || type === "observed-condition") {
            const completion = requireObject(state.completion, `${path}.completion`);
            const outcomes = requireStringArray(
                completion.outcomes,
                `${path}.completion.outcomes`,
            );
            const transition = requireObject(state.transition, `${path}.transition`);
            const handlerReference = requireTransitionReference(
                transition.handler,
                `${path}.transition.handler`,
            );
            const registration = options.transitions.resolve(handlerReference);
            for (const target of registration.allowedTargets) {
                if (!stateIds.has(target)) {
                    throw compilerError(
                        `Transition handler ${transitionReferenceLabel(handlerReference)} for state '${stateId}' declares unknown target '${target}'.`,
                        "WORKFLOW_TRANSITION_TARGET_INVALID",
                    );
                }
            }
            const transitionManifest = {
                handler: registration.moduleIdentity
                    ? { ...registration.moduleIdentity }
                    : { ...handlerReference },
                allowedTargets: [...registration.allowedTargets],
            };
            states[stateId] = {
                type: "activity",
                allowedOutcomes: outcomes,
                allowedTargets: [...registration.allowedTargets],
                execute: () => {
                    throw compilerError(
                        `Workflow state '${stateId}' requires registered workflow orchestration.`,
                        "WORKFLOW_REGISTERED_STATE_REQUIRED",
                    );
                },
                transition: transitionFromRegistration({
                    graphId,
                    metadata,
                    configuration,
                    registration,
                }),
            };

            if (type === "question") {
                const prompt = state.prompt;
                if (typeof prompt !== "string" || prompt.trim().length === 0) {
                    throw compilerError(`${path}.prompt must be a non-empty string.`);
                }
                const context = state.context ?? {};
                validateTemplate(context, `${path}.context`, stateIds);
                const authorization = state.authorization == null
                    ? { mode: "session-write" as const }
                    : requireObject(state.authorization, `${path}.authorization`);
                if (
                    authorization.mode !== "session-write"
                    || Object.keys(authorization).some(key => key !== "mode")
                ) {
                    throw compilerError(
                        `${path}.authorization must be { mode: "session-write" }.`,
                    );
                }
                stateManifests.push({
                    id: stateId,
                    type,
                    prompt: prompt.trim(),
                    context,
                    authorization: { mode: "session-write" },
                    completion: { outcomes },
                    transition: transitionManifest,
                });
                continue;
            }

            const provider = requireString(state.provider, `${path}.provider`);
            if (type === "action") {
                const operation = requireString(state.operation, `${path}.operation`);
                const inputTemplate = state.input ?? {};
                validateTemplate(inputTemplate, `${path}.input`, stateIds);
                stateManifests.push({
                    id: stateId,
                    type,
                    provider,
                    operation,
                    input: inputTemplate,
                    completion: { outcomes },
                    transition: transitionManifest,
                });
                continue;
            }

            const operationTemplate = state.operation ?? {};
            const conditionsTemplate = state.conditions ?? {};
            validateTemplate(operationTemplate, `${path}.operation`, stateIds);
            validateTemplate(conditionsTemplate, `${path}.conditions`, stateIds);
            const pollIntervalMs = state.pollIntervalMs == null
                ? 5_000
                : Number(state.pollIntervalMs);
            if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100) {
                throw compilerError(
                    `${path}.pollIntervalMs must be an integer of at least 100.`,
                );
            }
            stateManifests.push({
                id: stateId,
                type,
                provider,
                operation: operationTemplate,
                conditions: conditionsTemplate,
                pollIntervalMs,
                completion: { outcomes },
                transition: transitionManifest,
            });
            continue;
        }

        if (type !== "agent") {
            throw compilerError(
                `${path}.type '${type}' is not supported.`,
                "WORKFLOW_STATE_TYPE_UNSUPPORTED",
            );
        }

        const agent = requireString(state.agent, `${path}.agent`);
        const inputTemplate = state.input ?? {};
        validateTemplate(inputTemplate, `${path}.input`, stateIds);
        const result = requireObject(state.result, `${path}.result`);
        const resultSchema = requireString(result.schema, `${path}.result.schema`);
        const completion = requireObject(state.completion, `${path}.completion`);
        const completionMode = requireString(completion.mode, `${path}.completion.mode`);
        if (completionMode !== "one-shot") {
            throw compilerError(
                `${path}.completion.mode '${completionMode}' is not supported by the initial compiler.`,
                "WORKFLOW_COMPLETION_MODE_UNSUPPORTED",
            );
        }
        const outcomes = requireStringArray(completion.outcomes, `${path}.completion.outcomes`);
        const transition = requireObject(state.transition, `${path}.transition`);
        const handlerReference = requireTransitionReference(
            transition.handler,
            `${path}.transition.handler`,
        );
        const registration = options.transitions.resolve(handlerReference);
        for (const target of registration.allowedTargets) {
            if (!stateIds.has(target)) {
                throw compilerError(
                    `Transition handler ${transitionReferenceLabel(handlerReference)} for state '${stateId}' declares unknown target '${target}'.`,
                    "WORKFLOW_TRANSITION_TARGET_INVALID",
                );
            }
        }

        states[stateId] = {
            type: "agent",
            agent,
            allowedOutcomes: outcomes,
            allowedTargets: [...registration.allowedTargets],
            prompt: context => {
                const resolvedInput = resolveWorkflowTemplate(
                    inputTemplate,
                    `${path}.input`,
                    {
                        inputs: context.workflowInputs,
                        configuration,
                        latestStateOutputs: context.latestStateOutputs,
                    },
                );
                return [
                    `Execute workflow state '${stateId}' for '${graphId}'.`,
                    "",
                    "Input:",
                    JSON.stringify(resolvedInput, null, 2),
                    "",
                    `Submit exactly one declared outcome (${outcomes.join(", ")}) using submit_workflow_result.`,
                    `The output must satisfy result schema '${resultSchema}'.`,
                ].join("\n");
            },
            transition: transitionFromRegistration({
                graphId,
                metadata,
                configuration,
                registration,
            }),
        };
        stateManifests.push({
            id: stateId,
            type: "agent",
            agent,
            input: inputTemplate,
            resultSchema,
            completion: {
                mode: "one-shot",
                outcomes,
            },
            transition: {
                handler: registration.moduleIdentity
                    ? { ...registration.moduleIdentity }
                    : { ...handlerReference },
                allowedTargets: [...registration.allowedTargets],
            },
        });
    }

    const manifest: CompiledWorkflowManifest = {
        compilerVersion: WORKFLOW_COMPILER_VERSION,
        apiVersion: SUPPORTED_API_VERSION,
        kind: SUPPORTED_KIND,
        graphId,
        ...(options.packageSha256 ? { packageSha256: options.packageSha256 } : {}),
        metadata,
        inputSchema,
        ...(identity ? { identity } : {}),
        configuration,
        initialState,
        states: stateManifests,
    };

    return deepFreeze({
        graph: {
            id: graphId,
            initialState,
            states,
        },
        manifest,
        metadata,
        inputSchema,
        configuration,
    });
}

export function compileAndRegisterWorkflowYaml(
    yaml: string,
    options: {
        transitions: WorkflowTransitionRegistry;
        packageSha256?: string;
    },
): {
    compiled: CompiledWorkflowYaml;
    definition: Extract<WorkflowDefinitionSource, { kind: "in-memory" }>;
} {
    const compiled = compileWorkflowYaml(yaml, options);
    return {
        compiled,
        definition: registerInMemoryWorkflowGraph(compiled.graph),
    };
}
