import { stringify } from "yaml";

export const DECISION_DEFAULT = "team:decision-main";
export const DECISION_OVERRIDE = "spare:decision-other";
export const AGENT_OVERRIDE = "chat:chosen";
export const AVAILABLE_DECISION = {
    available: true, defaultModel: DECISION_DEFAULT,
    models: [DECISION_OVERRIDE, DECISION_DEFAULT], reason: null,
};
export const UNSET_DECISION = {
    available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default",
};
export const STALE_DECISION = {
    available: false, defaultModel: null, models: [], reason: "cluster_decision_default_ineligible",
};

export function decisionWorkflowYaml(name = "decision-models", { full = false } = {}) {
    const states = {
        route: {
            type: "decision",
            question: { type: "choice", instructions: "Choose the next step.", criteria: { keep: "Continue", stop: "Stop" } },
            timeoutSeconds: 30,
            transition: { next: { keep: full ? "score" : "done", stop: "done", failure: "failed" } },
        },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    };
    if (full) Object.assign(states, {
        score: {
            type: "decision", question: { type: "score", instructions: "Rank this input.", criteria: ["Low", "High"] },
            timeoutSeconds: 30, transition: { next: { scored: "fan", failure: "failed" } },
        },
        fan: {
            type: "parallel", forEach: "${input.items}",
            body: {
                initial: "nested",
                states: {
                    nested: {
                        type: "decision", question: { type: "noul", instructions: "Should this item continue?" },
                        timeoutSeconds: 30, transition: { next: { yes: "item_done", no: "item_done", failure: "item_done" } },
                    },
                    item_done: { type: "terminal", outcome: "succeeded" },
                },
            },
            transition: { next: { joined: "ask", blocked: "failed", failure: "failed" } },
        },
        ask: {
            type: "agent", invoke: { prompt: "Summarize the result." }, timeoutSeconds: 600,
            transition: { next: { done: "done", failure: "failed" } },
        },
    });
    return stringify({ apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name, version: "1.0.0" },
        ...(full ? { initialInput: { items: [1, 2] } } : {}), initial: "route", states });
}

export function agentWorkflowYaml(name = "agent-models-regression") {
    return stringify({ apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name, version: "1.0.0" }, initial: "ask", states: {
        ask: { type: "agent", invoke: { prompt: "Summarize the result." }, timeoutSeconds: 600,
            transition: { next: { done: "done", failure: "failed" } } },
        done: { type: "terminal", outcome: "succeeded" },
        failed: { type: "terminal", outcome: "failed" },
    } });
}

export function effectiveDecisionModels(model = DECISION_DEFAULT, { full = false } = {}) {
    return { route: { model }, ...(full ? { score: { model }, nested: { model } } : {}) };
}
