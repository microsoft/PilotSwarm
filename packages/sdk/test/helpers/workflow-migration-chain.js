import { readFileSync } from "node:fs";

const FIXTURE = new URL("../fixtures/workflow-migration-chain-01caf109.sql", import.meta.url);
const PLACEHOLDER = "pswf_chain_schema";
/**
 * The fixture keeps the names PR 270 had at 01caf109. Migration 0088 creates the same objects under the names the
 * Workflow rename gave them (its map's db-names and sql-session-function rules), so the chain is read with those names.
 */
const RENAMED = [
    [/\bcms_create_workflow_session_v2\b/g, "cms_create_workflow_session"],
    [/workflow_v2_/g, "workflow_"],
    [/workflow_v2(?![A-Za-z0-9_])/g, "workflow"],
];
const renamed = text => RENAMED.reduce((value, [pattern, name]) => value.replace(pattern, name), text);

/**
 * The Workflow migrations 0088-0111 as PR 270 had them before they were collapsed into migration 0088 (the frozen
 * fixture workflow-migration-chain-01caf109.sql), with today's object names, as migrator entries for `schema`.
 */
export function oldWorkflowChain(schema) {
    const entries = [];
    let current = null;
    let step = [];
    const endStep = () => { if (current) current.parts.push(step.join("\n")); step = []; };
    for (const line of readFileSync(FIXTURE, "utf8").split("\n")) {
        const start = /^-- @migration (\d{4}) (\S+) (sql|steps)$/.exec(line);
        if (start) {
            endStep();
            current = { version: start[1], name: start[2], mode: start[3], parts: [] };
            entries.push(current);
        } else if (line === "-- @step" && current?.mode === "steps") {
            endStep();
        } else if (current) {
            step.push(line);
        }
    }
    endStep();
    return entries.map(({ version, name, mode, parts }) => {
        const text = parts.map(part => renamed(part).split(PLACEHOLDER).join(schema));
        return mode === "sql" ? { version, name, sql: text[0] } : { version, name, steps: text };
    });
}
