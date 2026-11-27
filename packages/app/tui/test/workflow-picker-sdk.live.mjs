#!/usr/bin/env node
/**
 * Scripted live TUI smoke for Phase 4 Unit G (NodeSdkTransport -> SDK createSessionForWorkflow):
 * runs real NodeSdkTransport on local PG16 with a published package Workflow and verifies:
 *  - listCreatableWorkflows finds the published <pkg>/echo-flow
 *  - createSessionForWorkflow attaches the locked package definition, populates sessionHandles,
 *    queues the bootstrap kickoff event, and keeps owner === null when owner is omitted
 *  - PACKAGE_VERSION_CHANGED during attach deletes the session (S2SF-F3) with zero orphan left
 *
 * Usage: node packages/app/tui/test/workflow-picker-sdk.live.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { NodeSdkTransport } from "../src/node-sdk-transport.js";
import { loadDotEnv } from "../../mcp/test/integration/web-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../..");
loadDotEnv(ROOT);
if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set");
}

const baseDir = mkdtempSync(resolve(tmpdir(), "ps-tui-picker-live-"));
process.env.SESSION_STATE_DIR = resolve(baseDir, "session-state");
process.env.ARTIFACT_DIR = resolve(baseDir, "artifacts");

const PKG_NAME = `tui-smoke-${Date.now().toString(36)}`;
const ECHO_YAML = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: echo-flow
  version: "1.0.0"
inputs:
  schema:
    type: object
    required: [text]
    properties:
      text: { type: string }
    additionalProperties: false
initial: emit
states:
  emit:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { echoed: String(context.inputs.text ?? "") });
    transition:
      next:
        ok: done
        failure: failed
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;

const ECHO_CARD = `---
name: echo-flow
description: Echoes text back through a tiny script workflow.
whenToUse: Use to verify package workflow discovery and coordinating session creation.
inputs:
  example: { text: hello }
outcomes:
  done: Returned the echoed text.
  failed: Failed to run the script.
output: JSON object with echoed text.
effects: Pure script step with no external calls.
---
Ask the user for the text to echo, then start the workflow.
`;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

async function main() {
    const transport = new NodeSdkTransport({
        store: process.env.DATABASE_URL,
        embeddedWorkers: 0,
    });
    await transport.start();
    const createdIds = [];
    try {
        await transport.mgmt.uploadAgentPackage(
            [
                {
                    path: "plugin.json",
                    contentBase64: b64(JSON.stringify({
                        name: PKG_NAME,
                        version: "1.0.0",
                        description: "TUI live smoke package",
                    }, null, 2)),
                },
                { path: "workflows/echo-flow/workflow.yaml", contentBase64: b64(ECHO_YAML) },
                { path: "workflows/echo-flow/card.md", contentBase64: b64(ECHO_CARD) },
            ],
            "shared",
            null,
            true,
        );

        const list = await transport.listCreatableWorkflows();
        const found = list.find((w) => w.ref === `${PKG_NAME}/echo-flow`);
        assert.ok(found, `expected ${PKG_NAME}/echo-flow in listCreatableWorkflows`);

        // 1. Create without explicit owner -> currentUser acts as principal, owner stays null
        const created = await transport.createSessionForWorkflow(`${PKG_NAME}/echo-flow`, {});
        createdIds.push(created.sessionId);
        assert.equal(created.workflowRef, `${PKG_NAME}/echo-flow`);
        assert.equal(created.title, `echo-flow · ${PKG_NAME}`);
        assert.equal(transport.sessionHandles.has(created.sessionId), true, "sessionHandles must hold created handle");

        const listed = await transport.mgmt.listSessions();
        const sessionRow = listed.find((s) => s.sessionId === created.sessionId);
        assert.ok(sessionRow, "session must appear in listSessions");
        assert.equal(sessionRow?.owner ?? null, null, "owner must remain null when omitted");
        assert.equal(sessionRow?.workflowRef, `${PKG_NAME}/echo-flow`);

        const defs = await transport.mgmt.listSessionWorkflowDefinitions(created.sessionId);
        assert.ok(defs.some((d) => d.name === `${PKG_NAME}/echo-flow` && d.locked === true), "locked package def attached");

        const handle = transport.sessionHandles.get(created.sessionId);
        assert.ok(handle?.lastOrchestrationId, "kickoff send() must have queued a turn on the session orchestration");
        const status = await transport.mgmt.getSessionStatus(created.sessionId);
        assert.ok(status && status.orchestrationStatus !== "NotFound", "session orchestration started by kickoff");

        // 2. S2SF-F3: PACKAGE_VERSION_CHANGED during attach deletes the new session with zero orphan left
        const realPrepare = transport.mgmt.prepareSessionForWorkflow.bind(transport.mgmt);
        let skewedSessionId = null;
        const realCreate = transport.client.createSession.bind(transport.client);
        transport.client.createSession = async (...args) => {
            const s = await realCreate(...args);
            skewedSessionId = s.sessionId;
            return s;
        };
        transport.mgmt.prepareSessionForWorkflow = async (ref, viewer) => {
            const p = await realPrepare(ref, viewer);
            return { ...p, sha256: "0".repeat(64) };
        };
        await assert.rejects(
            transport.createSessionForWorkflow(`${PKG_NAME}/echo-flow`, {}),
            (err) => err?.code === "PACKAGE_VERSION_CHANGED",
        );
        assert.ok(skewedSessionId, "expected a session to have been created before attach failed");
        assert.equal(transport.sessionHandles.has(skewedSessionId), false, "failed session must not stay in sessionHandles");
        const orphan = await transport.mgmt.getSession(skewedSessionId).catch(() => null);
        assert.equal(orphan, null, "failed session must be deleted from CMS (S2SF-F3)");

        console.log(`✅ workflow-picker-sdk.live.mjs PASS (${PKG_NAME}/echo-flow)`);
    } finally {
        for (const id of createdIds) {
            await transport.mgmt.deleteSession(id).catch(() => {});
        }
        await transport.mgmt.deleteAgentPackage(PKG_NAME, null, true, { scope: "shared" }).catch(() => {});
        await transport.stop();
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
