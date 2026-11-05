import type { CopilotClient, CopilotClientOptions, CopilotSession } from "@github/copilot-sdk";
import path from "node:path";
import { createCopilotClient, type ToolCatalogPolicyResolver } from "./copilot-client.js";
import type { ToolCatalogCapability } from "./model-providers.js";

type Unsubscribe = () => void;

export interface AgentHarnessEventData {
    /** Final assistant text on assistant.message. */
    content?: string;
    /** Streamed assistant text on assistant.message_delta. */
    deltaContent?: string;
    /** Correlates user.message with the ID returned by send(). */
    messageId?: string;
    /** True on assistant.idle when an accepted run was aborted. */
    aborted?: boolean;
    /** Tool lifecycle projection used by activity and required-tool checks. */
    toolName?: string;
    toolArgs?: unknown;
    /** Error projection on session.error. */
    message?: string;
    stack?: string;
    [key: string]: unknown;
}

export type AgentHarnessEvent = {
    type:
        | "assistant.idle"
        | "assistant.message"
        | "assistant.message_delta"
        | "assistant.reasoning"
        | "assistant.reasoning_delta"
        | "assistant.turn_start"
        | "reasoning_delta"
        | "session.error"
        | "session.idle"
        | "tool.execution_complete"
        | "tool.execution_start"
        | "user.message"
        | (string & {});
    data?: AgentHarnessEventData;
    agentId?: string;
    timestamp?: string;
};

export type AgentHarnessEventType = AgentHarnessEvent["type"];

/**
 * Adapters emit `session.idle` exactly once after each accepted run;
 * `assistant.message.data.content` is authoritative final text, streaming uses
 * `assistant.message_delta.data.deltaContent`, and `user.message.data.messageId`
 * confirms the ID returned by send().
 */

export interface AgentHarnessTask {
    id: string;
    type: string;
    status?: string;
    pid?: number;
    startedAt?: string | number;
    toolCallId?: string;
    resolvedModel?: string;
    result?: string;
}

export interface AgentHarnessTaskProgress {
    type?: string;
    recentActivity?: Array<{ message: string; timestamp: string }>;
    latestIntent?: string;
}

export interface AgentHarnessTaskRpc {
    list(): Promise<{ tasks: AgentHarnessTask[] }>;
    cancel(input: { id: string }): Promise<{ cancelled: boolean }>;
    remove(input: { id: string }): Promise<unknown>;
    getProgress(input: { id: string }): Promise<{ progress?: AgentHarnessTaskProgress | null }>;
}

/** Live conversation exposed by a coding-agent harness. */
export interface AgentHarnessSession {
    readonly harness: string;
    readonly sessionId: string;
    send(message: unknown): Promise<string>;
    on(handler: (event: AgentHarnessEvent) => void): Unsubscribe;
    on(eventType: AgentHarnessEventType, handler: (event: AgentHarnessEvent) => void): Unsubscribe;
    abort(): Promise<unknown> | unknown;
    disconnect(): Promise<void>;
    getEvents(): Promise<unknown[]>;
    registerTools(tools: unknown[]): void;
    /** Native/background task control. A Pi MVP supplies an empty task view. */
    rpc: { tasks: AgentHarnessTaskRpc; [key: string]: unknown };
}

/** Process/runtime lifecycle used by SessionManager. */
export interface AgentHarnessClient {
    readonly harness: string;
    start?(): Promise<void>;
    createSession(config: unknown): Promise<AgentHarnessSession>;
    resumeSession(sessionId: string, config: unknown): Promise<AgentHarnessSession>;
    deleteSession(sessionId: string): Promise<void>;
    listModels(): Promise<unknown[]>;
    stop(): Promise<unknown[] | void>;
    forceStop(): Promise<void>;
}

export interface AgentHarnessClientOptions {
    gitHubToken?: string;
    logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
    env?: NodeJS.ProcessEnv;
    /** Exact root used by PilotSwarm snapshot probes and adapter persistence. */
    sessionStateDir: string;
}

export interface AgentHarnessClientContext {
    provider?: unknown;
    toolCatalog?: ToolCatalogCapability | ToolCatalogPolicyResolver;
}

export type AgentHarnessClientFactory = (
    options: AgentHarnessClientOptions,
    context?: AgentHarnessClientContext,
) => AgentHarnessClient;

class CopilotAgentHarnessSession implements AgentHarnessSession {
    readonly harness = "copilot";

    constructor(readonly raw: CopilotSession) {}

    get sessionId(): string { return this.raw.sessionId; }
    get rpc(): AgentHarnessSession["rpc"] { return this.raw.rpc as unknown as AgentHarnessSession["rpc"]; }
    send(message: unknown): Promise<string> { return this.raw.send(message as any); }
    on(handler: (event: AgentHarnessEvent) => void): Unsubscribe;
    on(eventType: AgentHarnessEventType, handler: (event: AgentHarnessEvent) => void): Unsubscribe;
    on(eventType: AgentHarnessEventType | ((event: AgentHarnessEvent) => void), handler?: (event: AgentHarnessEvent) => void): Unsubscribe {
        return typeof eventType === "function"
            ? this.raw.on(eventType as any)
            : this.raw.on(eventType as any, handler as any);
    }
    abort(): Promise<unknown> | unknown { return this.raw.abort(); }
    disconnect(): Promise<void> { return this.raw.disconnect(); }
    getEvents(): Promise<unknown[]> { return this.raw.getEvents(); }
    registerTools(tools: unknown[]): void { (this.raw as any).registerTools(tools); }
}

class CopilotAgentHarnessClient implements AgentHarnessClient {
    readonly harness = "copilot";
    readonly start?: () => Promise<void>;

    constructor(readonly raw: CopilotClient) {
        // Historical SessionManager.client test fakes may omit start(). Keep
        // that absence observable so _startClient preserves its no-op path.
        if (typeof (raw as any).start === "function") this.start = () => raw.start();
    }

    /** Copilot-only compatibility fields retained for existing internal tests. */
    get requestHandler(): any { return (this.raw as any).requestHandler; }
    get connectionConfig(): any { return (this.raw as any).connectionConfig; }
    async createSession(config: unknown): Promise<AgentHarnessSession> {
        return new CopilotAgentHarnessSession(await this.raw.createSession(config as any));
    }
    async resumeSession(sessionId: string, config: unknown): Promise<AgentHarnessSession> {
        return new CopilotAgentHarnessSession(await this.raw.resumeSession(sessionId, config as any));
    }
    deleteSession(sessionId: string): Promise<void> { return this.raw.deleteSession(sessionId); }
    listModels(): Promise<unknown[]> { return this.raw.listModels(); }
    stop(): Promise<unknown[] | void> { return this.raw.stop(); }
    forceStop(): Promise<void> { return this.raw.forceStop(); }
}

/** Wrap an existing Copilot session, including structurally compatible test fakes. */
export function createCopilotAgentHarnessSessionFrom(session: CopilotSession): AgentHarnessSession {
    return new CopilotAgentHarnessSession(session);
}

/** Wrap an existing Copilot client, including structurally compatible test fakes. */
export function createCopilotAgentHarnessClientFrom(client: CopilotClient): AgentHarnessClient {
    return new CopilotAgentHarnessClient(client);
}

/** Default adapter. Stage 1 preserves the pinned Copilot SDK behavior. */
export const createCopilotAgentHarnessClient: AgentHarnessClientFactory = (options, context) => {
    const { sessionStateDir, env, ...clientOptions } = options;
    return createCopilotAgentHarnessClientFrom(createCopilotClient(
        {
            ...clientOptions,
            // Copilot places session state under $COPILOT_HOME/session-state.
            // Translate the adapter's exact root instead of forwarding an
            // unsupported sessionStateDir option or using ambient storage.
            env: { ...(env ?? process.env), COPILOT_HOME: path.dirname(sessionStateDir) },
        } as CopilotClientOptions,
        context?.provider,
        context?.toolCatalog,
    ));
};

/** Compatibility accessor for code that intentionally uses Copilot-only RPCs. */
export function asCopilotSession(session: AgentHarnessSession): CopilotSession {
    if (session.harness !== "copilot" || !(session instanceof CopilotAgentHarnessSession)) {
        throw new Error(`The ${session.harness} harness does not expose a Copilot session.`);
    }
    return session.raw;
}

/** Compatibility accessor for the historical SessionManager.client property. */
export function asCopilotClient(client: AgentHarnessClient): CopilotClient {
    if (client.harness !== "copilot" || !(client instanceof CopilotAgentHarnessClient)) {
        throw new Error(`The ${client.harness} harness does not expose a Copilot client.`);
    }
    return client.raw;
}
