import { readFile } from "node:fs/promises";
import { PilotSwarmManagementClient } from "pilotswarm-sdk";
import { bootstrapApiAuth } from "./auth/cli.js";

export const SESSIONS_USAGE = `pilotswarm sessions — current-turn guidance

  steering-state <session-id>
  steer <session-id> --text <text> --client-request-id <id> --expected-target <token>
  steering-status <session-id> <request-id>
  steering-list <session-id> [--limit <1-200>] [--cursor <cursor>]
  withdraw-steering <session-id> <request-id>

Use --api-url <url> or PILOTSWARM_API_URL and existing pilotswarm auth login.
Add --json for structured results. No database credentials are required.
steer requires exactly one of --text <text>, --text-file <path>, or --stdin.
File/stdin input keeps guidance out of process arguments and supports multiline text.
--client-request-id is your retry identity; preserve it after a lost response.
Read steering-state for the observed --expected-target. Targets never auto-refresh.
Acceptance is not delivery or compliance. Send and Stop remain separate actions.
Exit zero means the operation succeeded, not that the agent received guidance.`;

export function parseSessionsArgs(argv) {
    const flags = {};
    const positional = [];
    const booleans = new Set(["json", "stdin", "help"]);
    const values = new Set(["api-url", "text", "text-file", "client-request-id", "expected-target",
        "limit", "cursor", "disposition", "attempt-cursor"]);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "-h") { flags.help = true; continue; }
        if (!argument.startsWith("--")) { positional.push(argument); continue; }
        const name = argument.slice(2);
        if (!booleans.has(name) && !values.has(name)) throw new Error(`Unknown option: ${argument}`);
        if (Object.hasOwn(flags, name)) throw new Error(`Repeated option: ${argument}`);
        if (booleans.has(name)) flags[name] = true;
        else {
            if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw new Error(`Missing value for ${argument}`);
            flags[name] = argv[++index];
        }
    }
    return { flags, positional };
}

async function readStdin(stream) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 2 * 1024 * 1024) throw new Error("Input exceeds the 2 MiB request envelope");
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

export async function executeSessionsCommand(client, { positional, flags }, { stdin = process.stdin, loadText = readFile } = {}) {
    const [command, sessionId, requestId] = positional;
    const withRequest = ["steering-status", "withdraw-steering"].includes(command);
    if (!["steering-state", "steer", "steering-status", "steering-list", "withdraw-steering"].includes(command)) {
        throw new Error(`Unknown sessions command: ${command || "(missing)"}`);
    }
    if (!sessionId || positional.length !== (withRequest ? 3 : 2)) throw new Error("Incorrect session/request arguments; use --help");
    const specific = {
        "steering-state": [], "withdraw-steering": [],
        "steering-status": ["attempt-cursor"],
        "steering-list": ["limit", "cursor", "disposition", "expected-target"],
        steer: ["text", "text-file", "stdin", "client-request-id", "expected-target"],
    }[command];
    const allowed = new Set(["api-url", "json", "help", ...specific]);
    for (const name of Object.keys(flags)) {
        if (!allowed.has(name)) throw new Error(`--${name} is not supported by ${command}`);
    }
    if (command === "steering-state") return client.getSessionSteeringState(sessionId);
    if (command === "steering-status") return client.getSteeringRequest(sessionId, requestId,
        flags["attempt-cursor"] ? { attemptCursor: flags["attempt-cursor"] } : {});
    if (command === "withdraw-steering") return client.withdrawSteeringRequest(sessionId, requestId);
    if (command === "steering-list") {
        const limit = flags.limit === undefined ? 50 : Number(flags.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit must be an integer from 1 to 200");
        return client.listSteeringRequests(sessionId, {
            limit, cursor: flags.cursor, dispositions: flags.disposition ? [flags.disposition] : undefined, expectedTarget: flags["expected-target"],
        });
    }
    const sources = ["text", "text-file", "stdin"].filter(name => Object.hasOwn(flags, name));
    if (sources.length !== 1) throw new Error("Supply exactly one of --text, --text-file, or --stdin");
    if (!flags["client-request-id"] || !flags["expected-target"]) throw new Error("--client-request-id and --expected-target are required");
    const text = flags.stdin ? await readStdin(stdin)
        : flags["text-file"] ? await loadText(flags["text-file"], "utf8") : flags.text;
    if (!text.trim()) throw new Error("Guidance must not be empty");
    if (Buffer.byteLength(text.trim(), "utf8") > 8192) throw new Error("Guidance exceeds 8 KiB of UTF-8 text");
    return client.steerSessionTurn(sessionId, {
        text, clientRequestId: flags["client-request-id"], expectedTarget: flags["expected-target"],
    });
}

export async function runSessionsCommand(argv, { output = console.log, errorOutput = console.error } = {}) {
    let json = argv.includes("--json");
    let client;
    try {
        const parsed = parseSessionsArgs(argv);
        json = Boolean(parsed.flags.json);
        if (parsed.flags.help || parsed.positional.length === 0) {
            output(SESSIONS_USAGE);
            return 0;
        }
        const apiUrl = String(parsed.flags["api-url"] || process.env.PILOTSWARM_API_URL || "").trim();
        if (!apiUrl) throw new Error("Pass --api-url <url> or set PILOTSWARM_API_URL");
        const { getAccessToken } = await bootstrapApiAuth(apiUrl, { interactive: false, output: errorOutput });
        client = new PilotSwarmManagementClient({ apiUrl, getAccessToken });
        await client.start();
        const result = await executeSessionsCommand(client, parsed);
        if (json) output(JSON.stringify(result));
        else if (result?.receipt) output(`${result.receipt.requestId}: ${result.outcome || result.receipt.disposition} (target ${result.receipt.expectedTarget})`);
        else if (result?.requestId) output(`${result.requestId}: ${result.disposition} (target ${result.expectedTarget})`);
        else output(JSON.stringify(result, null, 2));
        return result?.ok === false || ["forbidden", "not_found", "not_withdrawable"].includes(result?.outcome) ? 1 : 0;
    } catch (error) {
        errorOutput(json ? JSON.stringify({ error: { code: error.code || "CLI_ERROR", message: error.message } }) : error.message);
        return 1;
    } finally {
        if (client) await client.stop();
    }
}
