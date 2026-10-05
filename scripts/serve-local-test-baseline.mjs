#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const ASSET_DIR = path.join(SCRIPT_DIR, "local-test-baseline-dashboard");

function usage() {
    return `Usage:
  npm run test:campaign:dashboard -- [options]

Options:
  --results <path>  Campaign JSON (default: test-results/local-test-validation/campaign.json)
  --host <host>     Listen host (default: 127.0.0.1)
  --port <port>     Listen port (default: 4310)
  --help            Show this help
`;
}

function takeValue(args, index, name) {
    const arg = args[index];
    if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), consumed: 0 };
    if (arg === name) {
        if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
        return { value: args[index + 1], consumed: 1 };
    }
    return null;
}

export function parseDashboardArgs(args) {
    const options = {
        results: "test-results/local-test-validation/campaign.json",
        host: "127.0.0.1",
        port: 4310,
        help: false,
    };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        let parsed;
        if ((parsed = takeValue(args, index, "--results"))) {
            options.results = parsed.value;
            index += parsed.consumed;
        } else if ((parsed = takeValue(args, index, "--host"))) {
            options.host = parsed.value;
            index += parsed.consumed;
        } else if ((parsed = takeValue(args, index, "--port"))) {
            options.port = Number(parsed.value);
            index += parsed.consumed;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535");
    }
    if (!options.host.trim()) throw new Error("--host must not be empty");
    if (!isLoopbackHost(options.host)) {
        throw new Error("--host must be a loopback host (localhost, 127.0.0.1, or ::1)");
    }
    return options;
}

export function isLoopbackHost(host) {
    const normalized = String(host ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return normalized === "localhost"
        || normalized === "::1"
        || /^127(?:\.\d{1,3}){3}$/.test(normalized)
            && normalized.split(".").every((part) => Number(part) <= 255);
}

export function isLoopbackAuthority(authority) {
    if (!authority) return false;
    try {
        return isLoopbackHost(new URL(`http://${authority}`).hostname);
    } catch {
        return false;
    }
}

function sendJson(response, status, value) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendFile(response, filePath, contentType) {
    try {
        const content = fs.readFileSync(filePath);
        response.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "no-store",
        });
        response.end(content);
    } catch (error) {
        sendJson(response, error.code === "ENOENT" ? 404 : 500, {
            error: error.code === "ENOENT"
                ? "Dashboard asset is not available"
                : "Dashboard asset could not be read",
        });
    }
}

function readCampaign(resultsPath) {
    return JSON.parse(fs.readFileSync(resultsPath, "utf8"));
}

function ageMs(value, nowMs) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}

export function campaignProgress(campaign, nowMs = Date.now()) {
    const run = campaign.currentRun ?? null;
    const round = run?.rounds?.find((entry) => entry.number === run.round) ?? null;
    const activeFiles = Object.entries(run?.activeFiles ?? {}).map(([file, entry]) => ({
        file,
        slot: entry.slot,
        round: entry.round,
        startedAt: entry.startedAt,
        deadlineAt: entry.deadlineAt,
        elapsedMs: ageMs(entry.startedAt, nowMs),
        deadlineRemainingMs: entry.deadlineAt
            ? Math.max(0, Date.parse(entry.deadlineAt) - nowMs)
            : null,
    }));
    const heartbeatAgeMs = ageMs(run?.heartbeatAt, nowMs);
    return {
        campaignId: campaign.campaignId ?? null,
        status: campaign.status ?? "unknown",
        terminalReason: campaign.terminalReason ?? run?.terminalReason ?? null,
        phase: run?.phase ?? null,
        round: run?.round ?? null,
        heartbeatAt: run?.heartbeatAt ?? null,
        heartbeatAgeMs,
        heartbeatStale: run?.status === "running"
            && heartbeatAgeMs !== null
            && heartbeatAgeMs > 15_000,
        lastProgressAt: run?.lastProgressAt ?? null,
        lastProgressAgeMs: ageMs(run?.lastProgressAt, nowMs),
        lastTransitionAt: run?.lastTransitionAt ?? null,
        lastTransitionAgeMs: ageMs(run?.lastTransitionAt, nowMs),
        unfinished: campaign.summary?.unfinished ?? null,
        outcomes: {
            passed: campaign.summary?.passed ?? 0,
            failed: campaign.summary?.failed ?? 0,
            timed_out: campaign.summary?.timed_out ?? 0,
            mixed: campaign.summary?.mixed ?? 0,
        },
        roundProgress: round ? {
            number: round.number,
            kind: round.kind,
            status: round.status,
            total: round.total,
            queued: round.queued,
            active: round.active,
            completed: round.completed,
            remaining: round.remaining,
        } : null,
        activeFiles,
    };
}

export function createDashboardServer({
    resultsPath,
    assetDir = ASSET_DIR,
} = {}) {
    if (!resultsPath) throw new Error("resultsPath is required");
    const assets = new Map([
        ["/", ["index.html", "text/html; charset=utf-8"]],
        ["/index.html", ["index.html", "text/html; charset=utf-8"]],
        ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
        ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ]);

    return http.createServer((request, response) => {
        if (!isLoopbackAuthority(request.headers.host)) {
            sendJson(response, 403, { error: "Loopback Host header required" });
            return;
        }
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method !== "GET") {
            response.writeHead(405, { Allow: "GET" });
            response.end();
            return;
        }
        if (url.pathname === "/api/results") {
            try {
                const parsed = readCampaign(resultsPath);
                sendJson(response, 200, parsed);
            } catch (error) {
                sendJson(response, error.code === "ENOENT" ? 404 : 500, {
                    error: error.code === "ENOENT"
                        ? "Campaign results are not available"
                        : "Campaign results could not be read",
                });
            }
            return;
        }
        if (url.pathname === "/api/status" || url.pathname === "/api/health") {
            const available = fs.existsSync(resultsPath);
            let progress = null;
            let error = null;
            if (available) {
                try {
                    progress = campaignProgress(readCampaign(resultsPath));
                } catch {
                    error = "Campaign results could not be read";
                }
            }
            sendJson(response, 200, {
                ok: error === null,
                resultsAvailable: available,
                ...(progress ? { progress } : {}),
                ...(error ? { error } : {}),
            });
            return;
        }
        const asset = assets.get(url.pathname);
        if (!asset) {
            sendJson(response, 404, { error: "Not found" });
            return;
        }
        sendFile(response, path.join(assetDir, asset[0]), asset[1]);
    });
}

async function main() {
    const options = parseDashboardArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    const resultsPath = path.isAbsolute(options.results)
        ? options.results
        : path.resolve(REPO_ROOT, options.results);
    const server = createDashboardServer({ resultsPath });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    console.log(`PilotSwarm local test dashboard: http://${options.host}:${port}`);
    console.log(`Results: ${resultsPath}`);
    const close = () => server.close(() => process.exit(0));
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
}

const invokedDirectly = process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])).toLowerCase()
        === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
if (invokedDirectly) {
    main().catch((error) => {
        console.error(`ERROR: ${error.stack || error.message || error}`);
        process.exitCode = 1;
    });
}
