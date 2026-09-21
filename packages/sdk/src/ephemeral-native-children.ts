import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import type { EphemeralNativeChildrenOptions, EphemeralNativeChildProgress } from "./host-services.js";
import { EphemeralSessionError } from "./ephemeral-errors.js";

export const CHILD_PROGRESS_TOOL = "ephemeral_report_child_progress";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const fail = (): never => { throw new EphemeralSessionError("EPHEMERAL_CHILDREN_FAILED"); };

export function validateNativeChildren(value: unknown, callback: unknown): EphemeralNativeChildrenOptions | undefined {
    if (value === undefined && callback === undefined) return undefined;
    const invalid = (): never => { throw new EphemeralSessionError("EPHEMERAL_INVALID_REQUEST"); };
    if (!object(value) || typeof callback !== "function"
        || Object.keys(value).some(key => !["maxConcurrent", "assignments", "progressStages"].includes(key))
        || !Number.isInteger(value.maxConcurrent) || Number(value.maxConcurrent) < 1 || Number(value.maxConcurrent) > 20
        || !Array.isArray(value.assignments) || !value.assignments.length
        || !Array.isArray(value.progressStages) || !value.progressStages.length
        || value.progressStages.some(stage => typeof stage !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(stage))
        || new Set(value.progressStages).size !== value.progressStages.length) return invalid();
    const ids = new Set<string>(), refs = new Set<string>();
    const assignments = value.assignments.map(assignment => {
        if (!object(assignment) || Object.keys(assignment).some(key => !["id", "sessionRefs"].includes(key))
            || !identifier(assignment.id) || ids.has(assignment.id)
            || !Array.isArray(assignment.sessionRefs) || !assignment.sessionRefs.length) return invalid();
        ids.add(assignment.id);
        const sessionRefs = assignment.sessionRefs.map(ref => {
            if (!identifier(ref) || refs.has(ref)) return invalid();
            refs.add(ref);
            return ref;
        });
        return { id: assignment.id, sessionRefs };
    });
    return { maxConcurrent: Number(value.maxConcurrent), assignments, progressStages: [...value.progressStages] };
}

type Child = {
    assignmentId: string;
    allowed: Set<string>;
    iteration: number;
    childId?: string;
    callId?: string;
    started: boolean;
    completed: boolean;
    refs: Set<string>;
    stage: number;
};

/** Private execution policy. Runtime hook identities, never tool arguments, identify children. */
export class EphemeralNativeChildren {
    private readonly assignments: Map<string, Set<string>>;
    private readonly launches = new Map<string, Child>();
    private readonly children = new Map<string, Child>();
    private readonly events = new Set<string>();
    private sequence = 0;

    constructor(readonly options: EphemeralNativeChildrenOptions) {
        this.assignments = new Map(options.assignments.map(assignment => [assignment.id, new Set(assignment.sessionRefs)]));
    }

    reserve(args: unknown, iteration: number): string | undefined {
        if (!object(args) || args.agent_type !== "swarm-task" || args.mode !== "background"
            || typeof args.name !== "string" || !this.assignments.has(args.name)
            || typeof args.prompt !== "string" || !args.prompt || typeof args.description !== "string") {
            return "Use an assigned task name, swarm-task, and background mode.";
        }
        if (this.launches.has(args.name)) return "This assignment was already launched; do not respawn it.";
        if ([...this.launches.values()].filter(child => !child.completed).length >= this.options.maxConcurrent) {
            return "Native child capacity is full. Read/wait for existing children before launching remaining assignments.";
        }
        this.launches.set(args.name, { assignmentId: args.name, allowed: this.assignments.get(args.name)!,
            iteration, started: false, completed: false, refs: new Set(), stage: -1 });
        return undefined;
    }

    owns(childId: unknown): boolean { return typeof childId === "string" && this.children.has(childId); }

    private bind(child: Child, childId: string, callId: string): void {
        if (!childId || !callId || (child.childId && child.childId !== childId)
            || (child.callId && child.callId !== callId)
            || (this.children.has(childId) && this.children.get(childId) !== child)) return fail();
        child.childId = childId;
        child.callId = callId;
        this.children.set(childId, child);
    }

    authorizeRead(childId: unknown, tasks: Awaited<ReturnType<CopilotSession["rpc"]["tasks"]["list"]>>["tasks"], model: string): boolean {
        if (typeof childId !== "string") return false;
        const task = tasks.find(task => task.id === childId);
        if (!task || task.type !== "agent" || !task.displayName) return false;
        const child = this.launches.get(task.displayName);
        if (!child || task.agentType !== "swarm-task" || task.executionMode !== "background"
            || task.model !== model || (task.resolvedModel && task.resolvedModel !== model)) return false;
        // Native task receipts/registry precede subagent.started. An immediate
        // read must use this authoritative registry, not wait for a later event.
        this.bind(child, task.id, task.toolCallId);
        return true;
    }

    observe(event: SessionEvent, model: { model: string; reasoningEffort?: string; contextTier?: string }): void {
        if (!["subagent.started", "subagent.configured", "subagent.completed", "subagent.failed"].includes(event.type)) return;
        if (this.events.has(event.id)) return;
        this.events.add(event.id);
        if (!event.agentId) return fail();
        if (event.type === "subagent.started") {
            const child = this.launches.get(event.data.agentDisplayName);
            if (!child || child.started || event.data.parentId || event.data.agentName !== "swarm-task"
                || event.data.executionMode !== "background" || event.data.model !== model.model) return fail();
            this.bind(child, event.agentId, event.data.toolCallId);
            child.started = true;
        } else {
            const child = this.children.get(event.agentId);
            if (!child || !child.started) return fail();
            if (event.type === "subagent.configured") {
                if (event.data.model !== model.model
                    || (model.reasoningEffort && event.data.reasoningEffort !== model.reasoningEffort)
                    || (model.contextTier && event.data.contextTier !== model.contextTier)) {
                    throw new EphemeralSessionError("EPHEMERAL_MODEL_CHANGED");
                }
            } else if (event.type === "subagent.completed") {
                // CLI 1.0.85 replays a completion for an already-finished child,
                // flagged cancelled, as teardown noise. Absorb a repeat that still
                // matches the bound tool call; the first completion must still be
                // a clean, matching one, and a mismatched call always fails.
                if (event.data.toolCallId !== child.callId) return fail();
                if (child.completed) return;
                if (event.data.cancelled) return fail();
                child.completed = true;
            } else return fail();
        }
    }

    progress(childId: string, value: unknown): EphemeralNativeChildProgress | undefined {
        const child = this.children.get(childId);
        if (!child || !child.started || child.completed || !object(value)
            || Object.keys(value).some(key => !["stage", "completedSessionRefs"].includes(key))
            || typeof value.stage !== "string" || !Array.isArray(value.completedSessionRefs)) return undefined;
        const stage = this.options.progressStages.indexOf(value.stage);
        const refs = value.completedSessionRefs;
        if (stage < 0 || stage < child.stage || refs.some(ref => typeof ref !== "string" || !child.allowed.has(ref))
            || new Set(refs).size !== refs.length || [...child.refs].some(ref => !refs.includes(ref))
            || (stage === child.stage && refs.length === child.refs.size)) return undefined;
        child.refs = new Set(refs);
        child.stage = stage;
        return { assignmentId: child.assignmentId, childId, stage: value.stage, completedSessionRefs: [...refs],
            sequence: ++this.sequence, iteration: child.iteration, updatedAt: new Date().toISOString() };
    }

    assertComplete(): void {
        if (this.launches.size !== this.assignments.size || [...this.launches.values()].some(child => !child.completed)) fail();
    }
}
