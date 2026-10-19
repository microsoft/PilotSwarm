/**
 * Worker-side cron precheck evaluation: lookup by name, shadow vs skip, and
 * fail-open handling. No database or model.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    chooseCronPrecheck,
    evaluateCronPrecheck,
    normalizeCronPrecheckName,
    validateCronPrecheckBindings,
    validateCronPrecheckRegistration,
} from "../../src/cron-precheck.ts";
import { loadAgentFiles } from "../../src/agent-loader.ts";
import { loadAgentPackageCronPrechecks } from "../../src/agent-package-installer.ts";

const input = { sessionId: "s1", precheck: "queue", reason: "check the work queue", intervalSeconds: 300, consecutiveSkips: 0 };
const registration = (check, extra = {}) => validateCronPrecheckRegistration({ name: "queue", check, ...extra });

describe("cron precheck evaluation", () => {
    it("skips when the named precheck answers skip", async () => {
        const { result, event } = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "skip", detail: "queue empty" }))],
            input,
        });
        expect(result).toEqual({ skip: true, outcome: "skip", precheck: "queue", shadow: false });
        expect(event).toMatchObject({ precheck: "queue", outcome: "skip", skipped: true, shadow: false, detail: "queue empty" });
    });

    it("records a skip without skipping for a shadow registration", async () => {
        const { result, event } = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "skip" }), { shadow: true })],
            input,
        });
        expect(result).toEqual({ skip: false, outcome: "skip", precheck: "queue", shadow: true });
        expect(event).toMatchObject({ outcome: "skip", skipped: false, shadow: true });
    });

    it("runs the model for an unregistered name and records why", async () => {
        const { result, event } = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "skip" }))],
            input: { ...input, precheck: "other" },
        });
        expect(result).toEqual({ skip: false, outcome: "unregistered", precheck: "other" });
        expect(event).toMatchObject({ precheck: "other", outcome: "unregistered", skipped: false });
        expect((await evaluateCronPrecheck({ registrations: [], input })).result.outcome).toBe("unregistered");
    });

    it("passes the wake-up facts to the handler", async () => {
        let seen;
        await evaluateCronPrecheck({
            registrations: [registration((context) => { seen = context; return { action: "run" }; })],
            input: { ...input, consecutiveSkips: 3 },
        });
        expect(seen).toMatchObject({ sessionId: "s1", reason: input.reason, intervalSeconds: 300, consecutiveSkips: 3 });
        expect(seen.signal).toBeInstanceOf(AbortSignal);
    });

    it("runs the model on a thrown, invalid or timed-out handler", async () => {
        const thrown = await evaluateCronPrecheck({
            registrations: [registration(() => { throw new Error("backend down"); })],
            input,
        });
        expect(thrown.result).toMatchObject({ skip: false, outcome: "error" });
        expect(thrown.event.detail).toBe("backend down");

        const invalid = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "maybe" }))],
            input,
        });
        expect(invalid.result).toMatchObject({ skip: false, outcome: "invalid" });

        let aborted = false;
        const timeout = await evaluateCronPrecheck({
            registrations: [registration(({ signal }) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }), { timeoutMs: 20 })],
            input,
        });
        expect(timeout.result).toMatchObject({ skip: false, outcome: "timeout" });
        expect(aborted).toBe(true);
    });

    it("forces a model turn after maxConsecutiveSkips without calling the handler", async () => {
        let called = false;
        const { result } = await evaluateCronPrecheck({
            registrations: [registration(() => { called = true; return { action: "skip" }; }, { maxConsecutiveSkips: 2 })],
            input: { ...input, consecutiveSkips: 2 },
        });
        expect(result).toMatchObject({ skip: false, outcome: "max_skips" });
        expect(called).toBe(false);
    });

    it("normalizes names and rejects malformed ones", () => {
        expect(normalizeCronPrecheckName("  job-queue.v2 ")).toBe("job-queue.v2");
        expect(normalizeCronPrecheckName("app:queue_1")).toBe("app:queue_1");
        for (const bad of ["", "  ", "has space", "-leading", "x".repeat(101), 7, null, undefined]) {
            expect(normalizeCronPrecheckName(bad)).toBeNull();
        }
    });

    it("rejects malformed registrations", () => {
        const check = () => ({ action: "run" });
        expect(() => validateCronPrecheckRegistration({ name: "", check })).toThrow(/name/);
        expect(() => validateCronPrecheckRegistration({ name: "bad name", check })).toThrow(/name/);
        expect(() => validateCronPrecheckRegistration({ name: "x" })).toThrow(/check/);
        expect(() => validateCronPrecheckRegistration({ name: "x", check, timeoutMs: 0 })).toThrow(/timeoutMs/);
        expect(() => validateCronPrecheckRegistration({ name: "x", check, timeoutMs: 60_001 })).toThrow(/timeoutMs/);
        expect(() => validateCronPrecheckRegistration({ name: "x", check, maxConsecutiveSkips: 0 })).toThrow(/maxConsecutiveSkips/);
        expect(() => validateCronPrecheckRegistration({ name: "x", check, shadow: "yes" })).toThrow(/shadow/);
        expect(validateCronPrecheckRegistration({ name: " x ", check }).name).toBe("x");
    });
});

describe("choosing a schedule's cron precheck", () => {
    const pin = { packageIdentity: { packageId: "pkg-1", versionId: "v1", sha256: "a".repeat(64) }, packageBindingRevision: 1 };
    const sources = {
        ...pin,
        staticNames: ["app-gate"],
        packageId: "pkg-1",
        packageNames: ["queue-gate", "app-gate"],
        bindings: [
            { reason: "exact cycle", precheck: "queue-gate" },
            { reasonPrefix: "Run the queue cycle", precheck: "queue-gate" },
            { reasonPrefix: "Missing", precheck: "not-exported" },
        ],
    };

    it("uses nothing when no precheck is named, bound or defaulted", () => {
        expect(chooseCronPrecheck({ reason: "plain poll", sources })).toEqual({ ok: true });
        expect(chooseCronPrecheck({ reason: "plain poll" })).toEqual({ ok: true });
    });

    it("binds by exact reason or reason prefix from the agent definition, with the package", () => {
        expect(chooseCronPrecheck({ reason: "exact cycle", sources })).toEqual({ ok: true, precheck: "queue-gate", packageId: "pkg-1", ...pin });
        expect(chooseCronPrecheck({ reason: "exact cycle!", sources })).toEqual({ ok: true });
        expect(chooseCronPrecheck({ reason: "Run the queue cycle (scope=both)", sources }))
            .toEqual({ ok: true, precheck: "queue-gate", packageId: "pkg-1", ...pin });
    });

    it("keeps an unavailable binding so the fire records it and runs the model", () => {
        expect(chooseCronPrecheck({ reason: "Missing gate", sources })).toEqual({ ok: true, precheck: "not-exported", packageId: "pkg-1", ...pin });
    });

    it("lets a worker-registered name win over the same package name", () => {
        expect(chooseCronPrecheck({ explicit: "app-gate", reason: "x", sources })).toEqual({ ok: true, precheck: "app-gate" });
    });

    it("an explicit name beats the binding, and the binding beats the session default", () => {
        expect(chooseCronPrecheck({ explicit: "app-gate", reason: "exact cycle", sessionDefault: "queue-gate", sources }))
            .toEqual({ ok: true, precheck: "app-gate" });
        expect(chooseCronPrecheck({ reason: "exact cycle", sessionDefault: "app-gate", sources }))
            .toEqual({ ok: true, precheck: "queue-gate", packageId: "pkg-1", ...pin });
        expect(chooseCronPrecheck({ reason: "plain", sessionDefault: "queue-gate", sources }))
            .toEqual({ ok: true, precheck: "queue-gate", packageId: "pkg-1", ...pin });
        expect(chooseCronPrecheck({ reason: "plain", sessionDefault: "elsewhere", sources }))
            .toEqual({ ok: true, precheck: "elsewhere" });
    });

    it("will not arm an executable package name without a complete immutable binding pin", () => {
        for (const bad of [{ packageIdentity: undefined }, { packageBindingRevision: undefined }, { packageActive: false },
            { packageIdentity: { ...pin.packageIdentity, sha256: "short" } }]) {
            const invalid = { ...sources, ...bad };
            expect(chooseCronPrecheck({ reason: "exact cycle", sources: invalid }).ok).toBe(false);
            expect(chooseCronPrecheck({ explicit: "queue-gate", reason: "x", sources: invalid }).ok).toBe(false);
            expect(chooseCronPrecheck({ explicit: "app-gate", reason: "x", sources: invalid })).toEqual({ ok: true, precheck: "app-gate" });
        }
    });

    it("rejects an explicit name that is not available and lists what is", () => {
        const rejected = chooseCronPrecheck({ explicit: "typo", reason: "x", sources });
        expect(rejected.ok).toBe(false);
        expect(rejected.error).toContain("Available prechecks: app-gate, queue-gate");
        expect(chooseCronPrecheck({ explicit: "queue-gate", reason: "x", sources: { staticNames: [] } }).error)
            .toContain("No cron prechecks are available");
    });

    it("validates agent-definition bindings", () => {
        expect(validateCronPrecheckBindings([{ reasonPrefix: " Run ", precheck: " gate " }])).toEqual([{ reasonPrefix: "Run", precheck: "gate" }]);
        expect(() => validateCronPrecheckBindings([{ precheck: "gate" }])).toThrow(/exactly one/);
        expect(() => validateCronPrecheckBindings([{ reason: "a", reasonPrefix: "b", precheck: "gate" }])).toThrow(/exactly one/);
        expect(() => validateCronPrecheckBindings([{ reason: "a", precheck: "bad name" }])).toThrow(/precheck name/);
        expect(() => validateCronPrecheckBindings([{ reason: "a", precheck: "gate", extra: "x" }])).toThrow(/unknown field/);
        expect(() => validateCronPrecheckBindings("nope")).toThrow(/list/);
    });
});

describe("cron precheck declarations in agent definitions and packages", () => {
    const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ps-cron-precheck-"));

    it("parses a cronPrechecks block from agent frontmatter, with CRLF line endings", () => {
        const dir = tempDir();
        try {
            fs.writeFileSync(path.join(dir, "poller.agent.md"), [
                "---",
                "name: poller",
                "schemaVersion: 1",
                "version: 1.0.0",
                "cronPrechecks:",
                "  - reasonPrefix: \"Run the queue cycle\"",
                "    precheck: queue-gate",
                "  # a comment",
                "  - reason: 'exact cycle'",
                "    precheck: other-gate",
                "tools:",
                "  - read_facts",
                "---",
                "",
                "Poll the queue.",
            ].join("\r\n"));
            const [agent] = loadAgentFiles(dir);
            expect(agent.cronPrechecks).toEqual([
                { reasonPrefix: "Run the queue cycle", precheck: "queue-gate" },
                { reason: "exact cycle", precheck: "other-gate" },
            ]);
            expect(agent.tools).toEqual(["read_facts"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("accepts column-0 list items and never leaks them into tools", () => {
        const dir = tempDir();
        try {
            fs.writeFileSync(path.join(dir, "flat.agent.md"), [
                "---", "name: flat", "schemaVersion: 1", "version: 1.0.0",
                "tools:", "  - read_facts",
                "cronPrechecks:", "- reasonPrefix: Run the queue cycle", "  precheck: queue-gate",
                "skills:", "  - ops",
                "---", "", "Body.",
            ].join("\n"));
            const [agent] = loadAgentFiles(dir);
            expect(agent.cronPrechecks).toEqual([{ reasonPrefix: "Run the queue cycle", precheck: "queue-gate" }]);
            expect(agent.tools).toEqual(["read_facts"]);
            expect(agent.skills).toEqual(["ops"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("parses the documented inline comment without changing the cron reason", () => {
        const dir = tempDir();
        try {
            fs.writeFileSync(path.join(dir, "poller.agent.md"), [
                "---", "name: poller", "schemaVersion: 1", "version: 1.0.0",
                "cronPrechecks:",
                '  - reasonPrefix: "poll the job queue"   # or reason: for an exact match',
                "    precheck: job-queue",
                "---", "", "Body.",
            ].join("\n"));
            const [agent] = loadAgentFiles(dir);
            expect(agent.cronPrechecks).toEqual([{ reasonPrefix: "poll the job queue", precheck: "job-queue" }]);
            expect(chooseCronPrecheck({ reason: "poll the job queue (scope=both)", sources: {
                staticNames: ["job-queue"], bindings: agent.cronPrechecks,
            } })).toEqual({ ok: true, precheck: "job-queue" });
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it("preserves quoted hash characters and escaped quotes while stripping inline comments", () => {
        const dir = tempDir();
        try {
            fs.writeFileSync(path.join(dir, "poller.agent.md"), [
                "---", "name: poller", "schemaVersion: 1", "version: 1.0.0",
                "cronPrechecks: # only scheduled checks",
                '  - reason: "Run \\"queue #1\\"" # keep hash',
                "    precheck: gate-one # inline",
                "  - reason: 'Check the owner''s queue #2' # inline",
                "    precheck: 'gate-two' # inline",
                "  - reasonPrefix: queue#3 # comment",
                "    precheck: gate-three",
                "---", "", "Body.",
            ].join("\r\n"));
            const [agent] = loadAgentFiles(dir);
            expect(agent.cronPrechecks).toEqual([
                { reason: 'Run "queue #1"', precheck: "gate-one" },
                { reason: "Check the owner's queue #2", precheck: "gate-two" },
                { reasonPrefix: "queue#3", precheck: "gate-three" },
            ]);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it("skips an agent whose cronPrechecks block is malformed", () => {
        const dir = tempDir();
        try {
            fs.writeFileSync(path.join(dir, "broken.agent.md"), [
                "---", "name: broken", "schemaVersion: 1", "version: 1.0.0",
                "cronPrechecks:", "  - precheck: queue-gate", "---", "", "Body.",
            ].join("\n"));
            fs.writeFileSync(path.join(dir, "empty.agent.md"), [
                "---", "name: empty", "schemaVersion: 1", "version: 1.0.0",
                "cronPrechecks:", "tools:", "  - read_facts", "---", "", "Body.",
            ].join("\n"));
            expect(loadAgentFiles(dir)).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("uses inspected metadata and a supervised callback proxy, never a parent import/factory", async () => {
        const calls = [];
        const signal = new AbortController().signal;
        const pkg = {
            workerModulePath: "nonexistent-do-not-import.mjs", versionId: "v1",
            inspection: { execution: { cronPrechecks: { "queue-gate": { callback: "queue", shadow: true, timeoutMs: 123 } } } },
            runtime: { invokeCallback: async (...args) => { calls.push(args); return { action: "skip" }; } },
        };
        const [precheck] = await loadAgentPackageCronPrechecks(pkg);
        expect(precheck).toMatchObject({ name: "queue-gate", shadow: true, timeoutMs: 123 });
        expect(await precheck.check({ sessionId: "s", reason: "poll", signal, intervalSeconds: 5, consecutiveSkips: 2 }))
            .toEqual({ action: "skip" });
        expect(calls[0].slice(0, 3)).toEqual(["s", "queue", { sessionId: "s", reason: "poll", intervalSeconds: 5, consecutiveSkips: 2 }]);
        expect(calls[0][3].signal).toBe(signal);
        await expect(loadAgentPackageCronPrechecks({ workerModulePath: "legacy.mjs" })).rejects.toThrow(/DENIED/);
        expect(await loadAgentPackageCronPrechecks({ workerModulePath: null })).toEqual([]);
    });
});