import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { createWorkflow } from "../../src/workflow/service.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";

const getEnv = useSuiteEnv(import.meta.url);
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: carry-worker, version: "1.0.0" }
initial: count
initialInput: { carry: { attempts: 0 } }
limits: { maxNodeExecutions: 20 }
states:
  count:
    type: script
    input: "\${input.carry.attempts}"
    source: |
      await setResult("try", { attempts: context.input + 1 });
    transition: { next: { try: poll, failure: failed } }
  poll:
    type: script
    carry: { attempts: "\${input.attempts}" }
    input: "\${input.attempts}"
    outputSchema: { type: integer }
    source: |
      if (context.input < 3) process.exit(3);
      await setResult("ok", context.input);
    transition: { next: { ok: done, execution_failed: count, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output: { attempts: "\${input.carry.attempts}", result: "\${input.result}" }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;

it("the real worker keeps the attempt counter through two script crashes and validates only the raw script output", { timeout: testTime.ms(120_000) }, async () => {
    const compiled = compileWorkflow(YAML);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async client => {
        const host = { catalog: client._catalog, store: client._catalog.workflowStore(), duroxideClient: client.duroxideClient };
        const created = await createWorkflow(host, { workflowSessionId: randomUUID(), parentSessionId: null, yaml: YAML,
            actor: { kind: "system", name: "carry-worker" }, operationId: "carry-worker", start: { inputs: {} } });
        const result = await client.duroxideClient.waitForOrchestration(created.receipt.run.controllerInstanceId, testTime.ms(60_000));
        expect(result.status, JSON.stringify(result)).toBe("Completed");
        const run = await host.store.readRun(created.receipt.run.runId);
        expect(run).toMatchObject({ controllerVersion: "1.1.0", terminalOutcome: "succeeded", terminalOutput: { attempts: 3, result: 3 } });
        const visits = (await host.store.listNodeExecutions(run.runId)).filter(node => node.nodeId === "poll");
        expect(visits.map(node => ({ ordinal: node.ordinal, input: node.input, carry: node.carrySnapshot, outcome: node.outcome }))).toEqual([
            { ordinal: 1, input: 1, carry: { attempts: 1 }, outcome: "execution_failed" },
            { ordinal: 2, input: 2, carry: { attempts: 2 }, outcome: "execution_failed" },
            { ordinal: 3, input: 3, carry: { attempts: 3 }, outcome: "ok" },
        ]);
    });
});
