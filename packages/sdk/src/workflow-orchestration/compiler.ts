import { parseDocument } from "yaml";
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

export interface WorkflowTransitionRegistration {
    allowedTargets: readonly string[];
    handler: WorkflowTransitionHandler;
}

export interface CompiledWorkflowYaml {
    graph: InMemoryWorkflowGraph;
    metadata: Readonly<WorkflowPackageMetadata>;
    inputSchema: Readonly<JsonObject>;
    configuration: Readonly<JsonObject>;
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
        throw compilerError(`${path} must contain at least one outcome.`);
    }
    const values = value.map((item, index) => requireString(item, `${path}[${index}]`));
    if (new Set(values).size !== values.length) {
        throw compilerError(`${path} must not contain duplicate outcomes.`);
    }
    return values;
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

function resolveTemplate(
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
        return value.map((item, index) => resolveTemplate(item, `${path}[${index}]`, context));
    }
    if (isObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [
                key,
                resolveTemplate(nested, `${path}.${key}`, context),
            ]),
        );
    }
    return value;
}

function transitionFromRegistration(input: {
    graphId: string;
    metadata: WorkflowPackageMetadata;
    configuration: JsonObject;
    registration: WorkflowTransitionRegistration;
}): (context: WorkflowTransitionContext) => string {
    return context => {
        const directive = input.registration.handler(deepFreeze({
            graphId: input.graphId,
            metadata: { ...input.metadata },
            configuration: input.configuration,
            workflowInputs: context.workflowInputs,
            currentStateId: context.currentStateId,
            stateOutcome: context.stateOutcome,
            stateOutput: context.stateOutput,
            completion: {},
            latestStateOutputs: context.latestStateOutputs,
            executionHistory: context.executionHistory,
        }));
        if (
            directive
            && typeof (directive as unknown as PromiseLike<unknown>).then === "function"
        ) {
            throw compilerError(
                `Transition handler for state '${context.currentStateId}' returned a promise; transition handlers must be synchronous.`,
                "WORKFLOW_TRANSITION_ASYNC",
            );
        }
        if (!isObject(directive) || typeof directive.kind !== "string") {
            throw compilerError(
                `Transition handler for state '${context.currentStateId}' must return a transition directive.`,
                "WORKFLOW_TRANSITION_RESULT_INVALID",
            );
        }
        if (directive.kind === "resume-producer") {
            throw compilerError(
                `Transition handler for state '${context.currentStateId}' returned resume-producer, which is not supported for one-shot states.`,
                "WORKFLOW_TRANSITION_DIRECTIVE_UNSUPPORTED",
            );
        }
        if (directive.kind !== "advance") {
            throw compilerError(
                `Transition handler for state '${context.currentStateId}' returned unknown directive '${directive.kind}'.`,
                "WORKFLOW_TRANSITION_RESULT_INVALID",
            );
        }
        return requireString(
            directive.target,
            `Transition handler for state '${context.currentStateId}' advance target`,
        );
    };
}

export class WorkflowTransitionRegistry {
    private readonly registrations = new Map<string, WorkflowTransitionRegistration>();

    register(name: string, registration: WorkflowTransitionRegistration): this {
        const normalizedName = requireString(name, "Transition handler name");
        if (!registration || typeof registration.handler !== "function") {
            throw compilerError(
                `Transition handler '${normalizedName}' must provide a handler function.`,
                "WORKFLOW_TRANSITION_HANDLER_INVALID",
            );
        }
        const allowedTargets = requireStringArray(
            registration.allowedTargets,
            `Transition handler '${normalizedName}' allowedTargets`,
        );
        if (this.registrations.has(normalizedName)) {
            throw compilerError(
                `Transition handler '${normalizedName}' is already registered.`,
                "WORKFLOW_TRANSITION_HANDLER_ALREADY_REGISTERED",
            );
        }
        this.registrations.set(normalizedName, deepFreeze({
            allowedTargets: [...allowedTargets],
            handler: registration.handler,
        }));
        return this;
    }

    resolve(name: string): WorkflowTransitionRegistration {
        const normalizedName = requireString(name, "Transition handler name");
        const registration = this.registrations.get(normalizedName);
        if (!registration) {
            throw compilerError(
                `Transition handler '${normalizedName}' is not registered.`,
                "WORKFLOW_TRANSITION_HANDLER_NOT_REGISTERED",
            );
        }
        return registration;
    }
}

export function compileWorkflowYaml(
    yaml: string,
    options: { transitions: WorkflowTransitionRegistry },
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
    const inputSchema = root.inputs == null ? {} : requireObject(root.inputs, "inputs");
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
            states[stateId] = {
                type: "terminal",
                outcome: outcome as "succeeded" | "blocked" | "failed" | "cancelled",
                summary: typeof state.summary === "string" && state.summary.trim()
                    ? state.summary.trim()
                    : `Workflow '${metadata.name}' completed with outcome '${outcome}'.`,
                ...(Object.prototype.hasOwnProperty.call(state, "output")
                    ? {
                        result: context => resolveTemplate(
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
            continue;
        }

        if (type !== "agent") {
            throw compilerError(
                `${path}.type '${type}' is not supported by the initial compiler; only agent and terminal states are supported.`,
                "WORKFLOW_STATE_TYPE_UNSUPPORTED",
            );
        }
        if (state.next != null || state.transitions != null || state.events != null) {
            throw compilerError(
                `${path} uses inline transition syntax; declare transition.handler instead.`,
                "WORKFLOW_INLINE_TRANSITION_UNSUPPORTED",
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
        const handlerName = requireString(transition.handler, `${path}.transition.handler`);
        const registration = options.transitions.resolve(handlerName);
        for (const target of registration.allowedTargets) {
            if (!stateIds.has(target)) {
                throw compilerError(
                    `Transition handler '${handlerName}' for state '${stateId}' declares unknown target '${target}'.`,
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
                const resolvedInput = resolveTemplate(
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
    }

    return deepFreeze({
        graph: {
            id: graphId,
            initialState,
            states,
        },
        metadata,
        inputSchema,
        configuration,
    });
}

export function compileAndRegisterWorkflowYaml(
    yaml: string,
    options: { transitions: WorkflowTransitionRegistry },
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
