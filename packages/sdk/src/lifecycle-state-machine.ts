import { createHash } from "node:crypto";

import {
    loadLifecycleStateMarkdown,
    resolveLifecycleStateSources,
    type LifecycleStateOwner,
    type LifecycleStateReader,
    type LifecycleStateSource,
} from "./lifecycle-state-loader.js";
import {
    parseLifecycleStateTransitions,
    type LifecycleStateOutcome,
} from "./lifecycle-state-transitions.js";

export const LIFECYCLE_STATE_MACHINE_SNAPSHOT_VERSION = 1 as const;
const MAX_SNAPSHOT_STATES = 512;

export interface LifecycleStateMachineSnapshotState {
    owner: LifecycleStateOwner;
    sourceId: string;
    sourcePath: string;
    sourceCommit: string;
    markdown: string;
    markdownSha256: string;
    outcomes: readonly Readonly<LifecycleStateOutcome>[];
    terminal: boolean;
}

export interface LifecycleStateMachineSnapshot {
    version: typeof LIFECYCLE_STATE_MACHINE_SNAPSHOT_VERSION;
    lifecycleName: string;
    initialState: string;
    sources: readonly Readonly<LifecycleStateSource>[];
    states: Readonly<Record<string, Readonly<LifecycleStateMachineSnapshotState>>>;
    sha256: string;
}

export interface CompileLifecycleStateMachineInput {
    lifecycleName: string;
    initialState: string;
    sources: readonly LifecycleStateSource[];
    reader: LifecycleStateReader;
}

function canonicalSnapshotContent(
    snapshot: Omit<LifecycleStateMachineSnapshot, "sha256">,
): string {
    return canonicalJson({
        version: snapshot.version,
        lifecycleName: snapshot.lifecycleName,
        initialState: snapshot.initialState,
        sources: [...snapshot.sources]
            .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
            .map((source) => ({ ...source })),
        states: Object.fromEntries(
            Object.entries(snapshot.states)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, state]) => [name, {
                    ...state,
                    outcomes: [...state.outcomes]
                        .sort((left, right) => (
                            left.outcome.localeCompare(right.outcome)
                            || left.toState.localeCompare(right.toState)
                        ))
                        .map((outcome) => ({ ...outcome })),
                }]),
        ),
    });
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function snapshotHash(snapshot: Omit<LifecycleStateMachineSnapshot, "sha256">): string {
    return createHash("sha256")
        .update(canonicalSnapshotContent(snapshot), "utf8")
        .digest("hex");
}

export async function compileLifecycleStateMachine(
    input: CompileLifecycleStateMachineInput,
): Promise<Readonly<LifecycleStateMachineSnapshot>> {
    const sources = await resolveLifecycleStateSources({
        sources: input.sources,
        reader: input.reader,
        resolveRequestedRefs: true,
    }, input.initialState);
    const pending = [input.initialState];
    const states = new Map<string, LifecycleStateMachineSnapshotState>();

    while (pending.length > 0) {
        const stateName = pending.shift()!;
        if (states.has(stateName)) continue;
        if (states.size >= MAX_SNAPSHOT_STATES) {
            throw new Error(`Lifecycle ${input.lifecycleName} exceeds ${MAX_SNAPSHOT_STATES} reachable states`);
        }
        const loaded = await loadLifecycleStateMarkdown({
            lifecycleName: input.lifecycleName,
            state: stateName,
            sources,
            reader: input.reader,
        });
        const transitions = parseLifecycleStateTransitions(loaded.markdown);
        const sourceCommit = loaded.source.resolvedCommit?.trim();
        if (!sourceCommit) {
            throw new Error(
                `Lifecycle source ${loaded.source.sourceId} did not resolve to an immutable commit`,
            );
        }
        states.set(stateName, {
            owner: loaded.owner,
            sourceId: loaded.source.sourceId,
            sourcePath: loaded.sourcePath,
            sourceCommit,
            markdown: loaded.markdown,
            markdownSha256: loaded.sha256,
            outcomes: transitions.outcomes.map((outcome) => Object.freeze({ ...outcome })),
            terminal: transitions.terminal,
        });
        for (const outcome of transitions.outcomes) {
            if (!states.has(outcome.toState) && !pending.includes(outcome.toState)) {
                pending.push(outcome.toState);
            }
        }
    }

    const withoutHash = {
        version: LIFECYCLE_STATE_MACHINE_SNAPSHOT_VERSION,
        lifecycleName: input.lifecycleName,
        initialState: input.initialState,
        sources,
        states: Object.fromEntries(
            [...states.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, state]) => [name, Object.freeze(state)]),
        ),
    };
    return Object.freeze({
        ...withoutHash,
        sha256: snapshotHash(withoutHash),
    });
}

export function validateLifecycleStateMachineSnapshot(
    value: unknown,
): Readonly<LifecycleStateMachineSnapshot> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Lifecycle state-machine snapshot must be an object");
    }
    const snapshot = value as LifecycleStateMachineSnapshot;
    if (snapshot.version !== LIFECYCLE_STATE_MACHINE_SNAPSHOT_VERSION) {
        throw new Error(`Unsupported lifecycle state-machine snapshot version: ${String(snapshot.version)}`);
    }
    if (typeof snapshot.lifecycleName !== "string" || !snapshot.lifecycleName.trim()) {
        throw new Error("Lifecycle state-machine snapshot lifecycleName is required");
    }
    if (typeof snapshot.initialState !== "string" || !snapshot.initialState.trim()) {
        throw new Error("Lifecycle state-machine snapshot initialState is required");
    }
    if (!Array.isArray(snapshot.sources) || !snapshot.states || typeof snapshot.states !== "object") {
        throw new Error("Lifecycle state-machine snapshot sources and states are required");
    }
    const sources = new Map<string, LifecycleStateSource>();
    for (const sourceValue of snapshot.sources) {
        if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) {
            throw new Error("Lifecycle state-machine snapshot source is invalid");
        }
        const source = sourceValue as LifecycleStateSource;
        if (typeof source.sourceId !== "string" || !source.sourceId.trim()
            || (source.owner !== "user" && source.owner !== "platform")
            || typeof source.filePrefix !== "string" || !source.filePrefix.trim()
            || typeof source.resolvedCommit !== "string" || !source.resolvedCommit.trim()) {
            throw new Error(`Lifecycle state-machine snapshot source ${String(source.sourceId)} is incomplete`);
        }
        if (sources.has(source.sourceId)) {
            throw new Error(`Lifecycle state-machine snapshot source ${source.sourceId} is duplicated`);
        }
        sources.set(source.sourceId, source);
    }
    if (!Object.hasOwn(snapshot.states, snapshot.initialState)) {
        throw new Error("Lifecycle state-machine snapshot does not contain its initial state");
    }
    for (const [stateName, stateValue] of Object.entries(snapshot.states)) {
        if (!stateValue || typeof stateValue !== "object" || Array.isArray(stateValue)) {
            throw new Error(`Lifecycle state-machine snapshot state ${stateName} is invalid`);
        }
        const state = stateValue as LifecycleStateMachineSnapshotState;
        if (typeof state.markdown !== "string"
            || typeof state.markdownSha256 !== "string"
            || typeof state.sourceId !== "string"
            || typeof state.sourcePath !== "string"
            || typeof state.sourceCommit !== "string"
            || (state.owner !== "user" && state.owner !== "platform")
            || !Array.isArray(state.outcomes)
            || typeof state.terminal !== "boolean") {
            throw new Error(`Lifecycle state-machine snapshot state ${stateName} is incomplete`);
        }
        const source = sources.get(state.sourceId);
        if (!source
            || source.owner !== state.owner
            || source.resolvedCommit !== state.sourceCommit) {
            throw new Error(`Lifecycle state-machine snapshot state ${stateName} source provenance is invalid`);
        }
        const markdownHash = createHash("sha256").update(state.markdown, "utf8").digest("hex");
        if (markdownHash !== state.markdownSha256) {
            throw new Error(`Lifecycle state-machine snapshot state ${stateName} Markdown hash is invalid`);
        }
        const parsed = parseLifecycleStateTransitions(state.markdown);
        if (state.terminal !== parsed.terminal
            || canonicalJson(state.outcomes) !== canonicalJson(parsed.outcomes)) {
            throw new Error(`Lifecycle state-machine snapshot state ${stateName} transitions are invalid`);
        }
        for (const outcome of state.outcomes) {
            if (!Object.hasOwn(snapshot.states, outcome.toState)) {
                throw new Error(
                    `Lifecycle state-machine snapshot state ${stateName} targets missing state ${outcome.toState}`,
                );
            }
        }
    }
    const { sha256, ...withoutHash } = snapshot;
    if (typeof sha256 !== "string" || snapshotHash(withoutHash) !== sha256) {
        throw new Error("Lifecycle state-machine snapshot hash is invalid");
    }
    return snapshot;
}
