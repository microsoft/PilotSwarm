/**
 * The rules a remote session runs under that are not about files or
 * processes (docs/proposals/compute-providers.md).
 *
 *   a. a GitHub Copilot model is refused on a compute target, by one rule
 *      that creation, a model switch, the list a session is offered and
 *      the worker's own start all use
 *   b. a host that is full says so with a code, and its limit is the
 *      host's to set
 *   c. a file mode that cannot name the session asking is refused, rather
 *      than answered with the worker's default folders
 *
 * Run: npx vitest run test/local/compute-models-and-limits.test.js
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { randomBytes } from "node:crypto";
import {
    COMPUTE_GITHUB_MODEL_REFUSAL, computeModelRefusal, computeUsableModelProviders,
} from "../../src/compute.ts";
import { COMPUTE_HOST_AT_CAPACITY, startComputeHost } from "../../src/compute-host.ts";
import { runWorkerHandshake } from "../../src/compute-handshake.ts";
import { createArtifactTools } from "../../src/artifact-tools.ts";

const PROVIDERS = [
    { id: "github-copilot", type: "github" },
    { id: "openai-shared", type: "openai" },
    { id: "azure-shared", type: "azure" },
];

describe("models on a compute target", () => {
    it("refuses a GitHub Copilot model there, and only there", () => {
        expect(computeModelRefusal("github", true)).toBe(COMPUTE_GITHUB_MODEL_REFUSAL);
        // A session that runs on the worker uses the token the worker has.
        expect(computeModelRefusal("github", false)).toBeNull();
        for (const type of ["openai", "azure", "anthropic", undefined]) {
            expect(computeModelRefusal(type, true)).toBeNull();
            expect(computeModelRefusal(type, false)).toBeNull();
        }
    });

    it("leaves those models out of the list a remote session is offered", () => {
        // Every provider the owner may use, narrowed to the usable ones.
        expect([...computeUsableModelProviders(PROVIDERS, null, true)]).toEqual(["openai-shared", "azure-shared"]);
        // A narrower set stays narrow.
        expect([...computeUsableModelProviders(PROVIDERS, new Set(["github-copilot", "openai-shared"]), true)])
            .toEqual(["openai-shared"]);
        // A session on the worker is offered exactly what it always was.
        expect(computeUsableModelProviders(PROVIDERS, null, false)).toBeNull();
        const allowed = new Set(["github-copilot"]);
        expect(computeUsableModelProviders(PROVIDERS, allowed, false)).toBe(allowed);
        // An owner with nothing usable left is offered nothing, not everything.
        expect([...computeUsableModelProviders(PROVIDERS, new Set(["github-copilot"]), true)]).toEqual([]);
    });
});

describe("a host component that is full", () => {
    const cleanups = [];
    // Last made, first taken down: the host's listener closes only once
    // nothing is connected to it.
    afterEach(async () => {
        for (const stop of cleanups.splice(0).reverse()) await stop().catch(() => {});
    });

    /** A bare TCP echo server standing in for the runtime behind the host. */
    async function runtime() {
        const server = net.createServer((socket) => socket.on("error", () => {}));
        cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
        await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
        return `127.0.0.1:${server.address().port}`;
    }

    function connect(address) {
        const [host, port] = address.split(":");
        return new Promise((resolve, reject) => {
            const socket = net.connect({ host, port: Number(port) }, () => resolve(socket));
            socket.once("error", reject);
        });
    }

    it("answers with its own code, and takes the limit it is given", async () => {
        const credential = { bindingId: "binding-1", secret: randomBytes(32).toString("hex") };
        const refusals = [];
        const host = await startComputeHost({
            ...credential,
            runtimeAddress: await runtime(),
            listen: "127.0.0.1:0",
            idleTimeoutMs: 0,
            maxConnections: 1,
            onConnectionClosed: ({ ok, error }) => { if (!ok && error) refusals.push(error); },
        });
        cleanups.push(() => host.close());

        const first = await connect(host.address);
        cleanups.push(async () => first.destroy());
        await runWorkerHandshake(first, credential);

        // The second connection is one more than this host allows.
        const second = await connect(host.address);
        cleanups.push(async () => second.destroy());
        await expect(runWorkerHandshake(second, credential)).rejects.toThrow();
        for (let i = 0; i < 40 && refusals.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(refusals).toHaveLength(1);
        // A limit, not a fault: it reads as one, and says what to change.
        expect(refusals[0].code).toBe(COMPUTE_HOST_AT_CAPACITY);
        expect(refusals[0].message).toContain("1 connections it allows");
        expect(refusals[0].message).toContain("--max-connections");
    });
});

describe("a file mode with no session", () => {
    it("is refused rather than answered with the worker's own folders", async () => {
        const tools = createArtifactTools({
            blobStore: {
                async downloadArtifact() { throw new Error("the artifact store must not be reached"); },
            },
            // A worker that is running at least one session elsewhere.
            localPathRootsFor: (sessionId) => (sessionId ? [] : undefined),
        });
        const read = tools.find((tool) => tool.name === "read_artifact");
        const answer = JSON.parse(await read.handler(
            { sessionId: "s1", filename: "x.bin", toFile: "/tmp/x.bin" },
            {},
        ));
        expect(answer.error).toBe("NO_SESSION_CONTEXT");
    });
});
