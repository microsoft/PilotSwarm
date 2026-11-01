import { describe, expect, it } from "vitest";
import { PilotSwarmClient } from "../../src/client.js";
import { WebPilotSwarmSession } from "../../src/web/web-client.ts";
import { assertEqual } from "../helpers/assertions.js";

describe("PilotSwarmClient wait status handling", () => {
    it("preserves the saved permanent compute error when a detail read observes an active orchestration", async () => {
        const client = new PilotSwarmClient({});
        const writes = [];
        const message = "COMPUTE_TARGET_DISABLED: enable the target, then resend";
        client._catalog = {
            getSession: async () => ({
                sessionId: "compute", state: "error", lastError: message,
                createdAt: new Date(), updatedAt: new Date(), currentIteration: 0,
            }),
            updateSession: async (...args) => writes.push(args),
        };
        client.duroxideClient = {
            getStatus: async () => ({
                status: "Running",
                customStatus: JSON.stringify({ status: "error", computeFailure: { code: "COMPUTE_TARGET_DISABLED", permanent: true }, error: message }),
            }),
        };
        expect((await client._getSessionInfo("compute")).error).toBe(message);
        expect(writes).toEqual([]);
    });

    it("direct wait surfaces a permanent compute status before a durable response exists", async () => {
        const client = new PilotSwarmClient({});
        client.duroxideClient = {
            waitForStatusChange: async () => ({
                status: "Running", customStatusVersion: 1,
                customStatus: JSON.stringify({
                    status: "error", computeFailure: { code: "COMPUTE_TARGET_DISABLED", permanent: true },
                    error: "COMPUTE_TARGET_DISABLED: enable the target, then resend",
                }),
            }),
            getValue: async () => { throw new Error("must not wait for a durable response"); },
        };
        await expect(client._waitForTurnResult_external("session-compute", "compute", undefined, 1_000))
            .rejects.toThrow("enable the target");
    });

    it("web sendAndWait surfaces a permanent compute status and can accept the next prompt", async () => {
        let failed = true;
        const api = {
            call: async method => {
                if (method === "getSessionStatus") return { customStatusVersion: 0, customStatus: { iteration: 0, responseVersion: 0, status: "idle" } };
                if (method === "sendMessage") return {};
                if (method === "waitForStatusChange") return failed
                    ? { customStatusVersion: 1, customStatus: { status: "error", computeFailure: { code: "COMPUTE_TARGET_DISABLED", permanent: true }, error: "Enable the compute target, then resend" } }
                    : { customStatusVersion: 2, customStatus: { status: "idle", iteration: 1, turnResult: { type: "completed", content: "recovered" } } };
                throw new Error(`Unexpected API method: ${method}`);
            },
        };
        const session = new WebPilotSwarmSession("web-compute", api);
        await expect(session.sendAndWait("first", 1_000)).rejects.toThrow("Enable the compute target");
        await expect(session.wait()).rejects.toThrow("No pending turn");
        failed = false;
        expect(await session.sendAndWait("second", 1_000)).toBe("recovered");
    });

    it("web authentication failures without compute metadata still use the ordinary durable response path", async () => {
        let responseReads = 0;
        const api = {
            call: async method => {
                if (method === "getSessionStatus") return { customStatusVersion: 0, customStatus: { iteration: 0, responseVersion: 0, status: "idle" } };
                if (method === "sendMessage") return {};
                if (method === "waitForStatusChange") return {
                    customStatusVersion: 1,
                    customStatus: { status: "error", authFailure: true, error: "status detail", responseVersion: 1 },
                };
                if (method === "getLatestResponse") {
                    responseReads++;
                    return { type: "error", content: "durable authentication detail", version: 1 };
                }
                throw new Error(`Unexpected API method: ${method}`);
            },
        };
        const session = new WebPilotSwarmSession("ordinary-auth", api);
        await expect(session.sendAndWait("ordinary prompt", 1_000)).rejects.toThrow("durable authentication detail");
        expect(responseReads).toBe(1);
    });

    it("syncs response cursors before fire-and-forget send", async () => {
        const calls = [];
        const fake = {
            _syncTurnCursors: async (orchestrationId) => calls.push(["sync", orchestrationId]),
            _ensureOrchestrationAndSend: async (sessionId, prompt) => {
                calls.push(["enqueue", sessionId, prompt]);
                return `session-${sessionId}`;
            },
        };

        const orchestrationId = await PilotSwarmClient.prototype._startTurn.call(fake, "fresh", "next");
        assertEqual(orchestrationId, "session-fresh", "returns the new orchestration id");
        assertEqual(JSON.stringify(calls), JSON.stringify([
            ["sync", "session-fresh"],
            ["enqueue", "fresh", "next"],
        ]), "cursor snapshot happens before enqueue");
    });

    it("raises a durable latest-response error instead of waiting for timeout", async () => {
        const client = new PilotSwarmClient({});
        client.duroxideClient = {
            waitForStatusChange: async () => ({
                status: "Running",
                customStatusVersion: 1,
                customStatus: JSON.stringify({
                    status: "error",
                    iteration: 0,
                    responseVersion: 1,
                    error: "Bad credentials — update the key in Admin",
                }),
            }),
            getValue: async () => JSON.stringify({
                schemaVersion: 1,
                version: 1,
                emittedAt: 1,
                iteration: 0,
                type: "error",
                content: "Bad credentials — update the key in Admin",
            }),
        };

        await expect(client._waitForTurnResult_external(
            "session-auth-error",
            "auth-error",
            undefined,
            1_000,
        )).rejects.toThrow("Bad credentials");
    });

    it("raises a web durable error response instead of waiting for timeout", async () => {
        const api = {
            call: async (method) => {
                if (method === "getSessionStatus") {
                    return { customStatusVersion: 0, customStatus: { iteration: 0, responseVersion: 0, status: "idle" } };
                }
                if (method === "sendMessage") return {};
                if (method === "waitForStatusChange") {
                    return {
                        customStatusVersion: 1,
                        customStatus: { iteration: 0, responseVersion: 1, status: "error" },
                        orchestrationStatus: "Running",
                    };
                }
                if (method === "getLatestResponse") {
                    return { type: "error", content: "Bad credentials — update the key in Admin", version: 1 };
                }
                throw new Error(`Unexpected API method: ${method}`);
            },
        };
        const session = new WebPilotSwarmSession("web-auth-error", api);

        await expect(session.sendAndWait("hi", 1_000)).rejects.toThrow("Bad credentials");
    });

    it("refreshes direct-client cursors before sendAndWait on a reused handle", async () => {
        const client = new PilotSwarmClient({});
        client.duroxideClient = {
            getStatus: async () => ({
                customStatusVersion: 9,
                customStatus: JSON.stringify({ iteration: 4, responseVersion: 4, status: "idle" }),
            }),
        };
        client._ensureOrchestrationAndSend = async () => {
            assertEqual(client.lastSeenStatusVersion.get("session-reused"), 9, "status cursor should refresh before enqueue");
            assertEqual(client.lastSeenIteration.get("session-reused"), 4, "iteration cursor should refresh before enqueue");
            assertEqual(client.lastSeenResponseVersion.get("session-reused"), 4, "response cursor should refresh before enqueue");
            return "session-reused";
        };
        client._waitForTurnResult = async () => "second response";

        const response = await client._startAndWait("reused", "second prompt", undefined, 1_000);
        assertEqual(response, "second response", "sendAndWait should wait from refreshed cursors");
    });

    it("refreshes web-client cursors after an unobserved fire-and-forget response", async () => {
        let completedResponses = 0;
        const statusSnapshots = [
            { customStatusVersion: 0, customStatus: { iteration: 0, responseVersion: 0, status: "idle" } },
            { customStatusVersion: 3, customStatus: { iteration: 1, responseVersion: 1, status: "idle" } },
        ];
        const api = {
            call: async (method, params) => {
                if (method === "getSessionStatus") return statusSnapshots.shift();
                if (method === "sendMessage") return {};
                if (method === "waitForStatusChange") {
                    assertEqual(params.afterVersion, 3, "second wait must start after the first completed turn");
                    return {
                        customStatusVersion: 4,
                        customStatus: { iteration: 2, responseVersion: 2, status: "idle" },
                        orchestrationStatus: "Running",
                    };
                }
                if (method === "getLatestResponse") {
                    completedResponses += 1;
                    return { type: "completed", content: "second response", version: 2 };
                }
                throw new Error(`Unexpected API method: ${method}`);
            },
        };
        const session = new WebPilotSwarmSession("web-reused", api);

        await session.send("first prompt");
        const response = await session.sendAndWait("second prompt", 1_000);

        assertEqual(response, "second response", "web sendAndWait should return the second response");
        assertEqual(completedResponses, 1, "only the post-refresh response should be read");
    });

    it("resets a stale status cursor when fallback getStatus observes a lower version", async () => {
        const client = new PilotSwarmClient({});
        const observedVersions = [];
        client.lastSeenStatusVersion.set("session-reset", 20);
        client.lastSeenIteration.set("session-reset", 1);
        client.lastSeenResponseVersion.set("session-reset", 1);
        client.duroxideClient = {
            waitForStatusChange: async (_orchestrationId, afterVersion) => {
                observedVersions.push(afterVersion);
                if (afterVersion === 0) {
                    return {
                        status: "Running",
                        customStatusVersion: 2,
                        customStatus: JSON.stringify({
                            status: "idle",
                            iteration: 2,
                            responseVersion: 2,
                        }),
                    };
                }
                return {
                    status: "Running",
                    customStatusVersion: afterVersion,
                    customStatus: JSON.stringify({
                        status: "running",
                        iteration: 1,
                        responseVersion: 1,
                    }),
                };
            },
            getStatus: async () => ({
                status: "Running",
                customStatusVersion: 1,
                customStatus: JSON.stringify({
                    status: "running",
                    iteration: 1,
                    responseVersion: 1,
                }),
            }),
            getValue: async () => JSON.stringify({
                type: "completed",
                content: "Recovered after status reset",
                version: 2,
            }),
        };

        const response = await client._waitForTurnResult_external(
            "session-reset",
            "reset",
            undefined,
            2_000,
        );

        assertEqual(response, "Recovered after status reset", "wait should recover after observing a lower status version");
        assertEqual(observedVersions.includes(0), true, "wait should retry from version 0 after the fallback detects a reset");
    });
});
