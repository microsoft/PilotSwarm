import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const workflowId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const childIds = [
    "11111111-bbbb-cccc-dddd-eeeeeeeeeeee",
    "22222222-bbbb-cccc-dddd-eeeeeeeeeeee",
    "33333333-bbbb-cccc-dddd-eeeeeeeeeeee",
];

const sessions = [
    {
        sessionId: workflowId,
        sessionKind: "workflow",
        title: "Arithmetic workflow",
        status: "idle",
        parentSessionId: null,
        createdAt: 1785000000000,
        updatedAt: 1785000042000,
    },
    ...childIds.map((sessionId, index) => ({
        sessionId,
        title: `Action ${String.fromCharCode(65 + index)}`,
        status: "idle",
        parentSessionId: workflowId,
        createdAt: 1785000000000 + index,
        updatedAt: 1785000042000 + index,
    })),
];

const executions = [
    {
        executionSequence: 1,
        stateId: "A",
        childSessionId: childIds[0],
        waitingOn: "agent-result",
        status: "accepted",
        outcome: "prepared",
        output: { expression: "23 + 19" },
        admittedAt: "2026-10-11T21:30:16.235Z",
        acceptedAt: "2026-10-11T21:30:23.763Z",
    },
    {
        executionSequence: 2,
        stateId: "B",
        childSessionId: childIds[1],
        waitingOn: "agent-result",
        status: "accepted",
        outcome: "solved",
        output: { result: 42 },
        admittedAt: "2026-10-11T21:30:24.301Z",
        acceptedAt: "2026-10-11T21:30:34.084Z",
    },
    {
        executionSequence: 3,
        stateId: "C",
        childSessionId: childIds[2],
        waitingOn: "agent-result",
        status: "accepted",
        outcome: "verified",
        output: { verified: true },
        admittedAt: "2026-10-11T21:30:34.694Z",
        acceptedAt: "2026-10-11T21:30:41.058Z",
    },
];

const transitionEvents = [
    [10, 11, Date.parse("2026-10-11T21:30:23.775Z"), Date.parse("2026-10-11T21:30:23.800Z"), 1, "B"],
    [20, 21, Date.parse("2026-10-11T21:30:34.097Z"), Date.parse("2026-10-11T21:30:34.118Z"), 2, "C"],
    [30, 31, Date.parse("2026-10-11T21:30:41.073Z"), Date.parse("2026-10-11T21:30:41.094Z"), 3, "succeeded"],
].flatMap(([scheduledId, completedId, scheduledAt, completedAt, sequence, target]) => [
    {
        eventId: scheduledId,
        kind: "ActivityScheduled",
        timestampMs: scheduledAt,
        data: JSON.stringify({
            name: "executeWorkflowTransitionV2",
            input: {
                context: {
                    executionHistory: Array.from(
                        { length: sequence },
                        (_, index) => ({ executionSequence: index + 1 }),
                    ),
                },
            },
        }),
    },
    {
        eventId: completedId,
        sourceEventId: scheduledId,
        kind: "ActivityCompleted",
        timestampMs: completedAt,
        data: JSON.stringify({
            kind: target === "succeeded" ? "succeed" : "advance",
            ...(target === "succeeded" ? {} : { target }),
        }),
    },
]);

test("workflow execution renders grouped timing and nested action accordions", async ({ page }) => {
    const stub = await startStubServer();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));

    await page.route("**/api/v1/**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const answer = result => route.fulfill({ json: { ok: true, result } });

        if (path.endsWith("/management/sessions")) {
            return answer({ sessions, hasMore: false, nextCursor: null });
        }
        const sessionMatch = /\/sessions\/([^/]+)$/.exec(path);
        if (sessionMatch) {
            const session = sessions.find(item => item.sessionId === sessionMatch[1]) ?? sessions[0];
            return answer({ ...session, messages: [], events: [], pendingMessages: [] });
        }
        if (path.endsWith(`/workflows/${workflowId}/overview`)) {
            return answer({
                workflowSessionId: workflowId,
                graph: {
                    graphId: "arithmetic-abc@1",
                    initialStateId: "A",
                    nodes: [
                        { id: "A", type: "agent" },
                        { id: "B", type: "agent" },
                        { id: "C", type: "agent" },
                        { id: "succeeded", type: "terminal" },
                    ],
                    edges: [
                        { from: "A", to: "B" },
                        { from: "B", to: "C" },
                        { from: "C", to: "succeeded" },
                    ],
                },
                projection: {
                    status: "completed",
                    currentStateId: "succeeded",
                    currentExecutionSequence: 3,
                    waitingOn: null,
                },
                executions: executions.map(({ executionSequence, stateId, status, waitingOn }) => ({
                    executionSequence,
                    stateId,
                    status,
                    waitingOn,
                })),
            });
        }
        if (path.endsWith(`/workflows/${workflowId}/executions`)) {
            return answer(executions);
        }
        const executionHistoryMatch = /\/management\/sessions\/([^/]+)\/execution-history$/.exec(path);
        if (executionHistoryMatch) {
            if (executionHistoryMatch[1] === workflowId) return answer(transitionEvents);
            const childIndex = childIds.indexOf(executionHistoryMatch[1]);
            return answer([{
                eventId: 100 + childIndex,
                kind: "ActivityScheduled",
                timestampMs: 1785000000000 + childIndex,
                data: JSON.stringify({
                    name: "runTurnV3",
                    input: { prompt: `Execute workflow action ${String.fromCharCode(65 + childIndex)}.` },
                }),
            }]);
        }
        const eventsMatch = /\/management\/sessions\/([^/]+)\/events$/.exec(path);
        if (eventsMatch) {
            const childIndex = childIds.indexOf(eventsMatch[1]);
            if (childIndex < 0) return answer([]);
            const events = [];
            if (childIndex === 2) {
                events.push(
                    {
                        seq: 1,
                        eventType: "tool.execution_start",
                        createdAt: "2026-10-11T21:30:35.000Z",
                        sessionId: eventsMatch[1],
                        data: {
                            toolCallId: "call-verify",
                            toolName: "verify_result",
                            arguments: { expected: 42, actual: 42 },
                        },
                    },
                    {
                        seq: 2,
                        eventType: "tool.execution_complete",
                        createdAt: "2026-10-11T21:30:35.100Z",
                        sessionId: eventsMatch[1],
                        data: {
                            toolCallId: "call-verify",
                            toolName: "verify_result",
                            success: true,
                            result: { verified: true },
                        },
                    },
                );
            }
            events.push({
                seq: events.length + 1,
                eventType: "assistant.message",
                timestamp: 1785000000000 + childIndex,
                data: { content: `Action ${String.fromCharCode(65 + childIndex)} completed.` },
            });
            return answer(events);
        }
        return route.fallback();
    });

    try {
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${workflowId}`);

        const workflowDefinition = page.locator(
            'details.ps-workflow-execution:has(> summary:has-text("Workflow definition"))',
        );
        const executionProgression = page.locator(
            'details.ps-workflow-execution:has(> summary:has-text("Execution progression"))',
        );
        const nodeActionDetails = page.locator(
            'details.ps-workflow-execution:has(> summary:has-text("Node action details (3)"))',
        );
        await expect(workflowDefinition).toHaveCount(1);
        await expect(executionProgression).toHaveCount(1);
        await expect(nodeActionDetails).toHaveCount(1);
        await expect(workflowDefinition).not.toHaveAttribute("open", "");
        await expect(executionProgression).toHaveAttribute("open", "");
        await expect(nodeActionDetails).toHaveAttribute("open", "");

        const actions = nodeActionDetails.locator(".ps-workflow-execution-body > details.ps-workflow-execution");
        await expect(actions).toHaveCount(3);
        await expect(actions.locator(":scope > summary")).toHaveText([
            /A · #1 · prepared → B/,
            /B · #2 · solved → C/,
            /C · #3 · verified → succeeded/,
        ]);
        await expect(actions.nth(0)).not.toHaveAttribute("open", "");
        await expect(actions.nth(1)).not.toHaveAttribute("open", "");
        await expect(actions.nth(2)).toHaveAttribute("open", "");

        await expect(executionProgression).not.toContainText(".800Z");
        await expect(executionProgression).not.toContainText(".094Z");
        await expect(actions.nth(2)).toContainText("Transition function");
        await expect(actions.nth(2)).not.toContainText(".073Z");
        await expect(actions.nth(2)).toContainText("21 ms");
        await expect(actions.nth(2)).toContainText("succeeded");
        await expect(actions.nth(2).getByText("Agent prompt", { exact: true })).toBeVisible();
        await expect(actions.nth(2).getByText("Agent transcript", { exact: true })).toBeVisible();
        await expect(actions.nth(2)).toContainText("Execute workflow action C.");
        await expect(
            actions.nth(2).locator(".ps-activity-run-summary").filter({ hasText: "tool call" }),
        ).toContainText("1 tool call");

        await actions.nth(0).locator(":scope > summary").click();
        await expect(actions.nth(0)).toHaveAttribute("open", "");
        await expect(actions.nth(0)).toContainText("Execute workflow action A.");
        await expect(actions.nth(0)).toContainText("Action A completed.");

        await page.goto(`http://127.0.0.1:${stub.port}/?session=${childIds[2]}`);
        const childContext = page.locator(
            'details.ps-workflow-execution:has(> summary:has-text("Workflow execution context · C · #3"))',
        );
        await expect(childContext).toBeVisible();
        await expect(childContext.getByText("Agent prompt", { exact: true })).toBeVisible();
        await expect(childContext.getByText("Agent transcript", { exact: true })).toBeVisible();
        const childPrompt = childContext.locator(".ps-activity-run")
            .filter({ hasText: "agent activity" })
            .first();
        await expect(childPrompt).toBeVisible();
        await childPrompt.locator(":scope > summary").click();
        await expect(childContext.locator(".ps-activity-run")).toHaveCount(2);
        await expect(childContext.locator(".ps-assistant-preview")).toBeVisible();
        await expect(childContext).toContainText("Execute workflow action C.");
        await expect(childContext).toContainText("Action C completed.");
        await expect(childContext).toContainText("Outcome: verified");
        await expect(childContext).toContainText("Selected next state: succeeded");
        await expect(
            page.locator(".ps-activity-run-summary").filter({ hasText: "tool call" }),
        ).toContainText("1 tool call");
        await page.getByRole("button", { name: "← Back to workflow: Arithmetic workflow" }).click();
        await expect(page.locator(
            'details.ps-workflow-execution:has(> summary:has-text("Execution progression"))',
        )).toBeVisible();
        expect(errors).toEqual([]);
    } finally {
        await new Promise(resolve => stub.server.close(resolve));
    }
});
