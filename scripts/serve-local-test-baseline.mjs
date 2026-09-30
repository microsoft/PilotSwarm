#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const ASSET_DIR = path.join(SCRIPT_DIR, "local-test-baseline-dashboard");

function usage() {
    return `Usage:
  npm run test:local:baseline:dashboard -- [options]

Options:
  --results <path>  Results JSON (default: pilotswarm-local-test-baseline.json)
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
        results: "pilotswarm-local-test-baseline.json",
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
    return options;
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
            error: error.message,
        });
    }
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
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method !== "GET") {
            response.writeHead(405, { Allow: "GET" });
            response.end();
            return;
        }
        if (url.pathname === "/api/results") {
            try {
                const parsed = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
                sendJson(response, 200, parsed);
            } catch (error) {
                sendJson(response, error.code === "ENOENT" ? 404 : 500, {
                    error: error.code === "ENOENT"
                        ? `Results file not found: ${resultsPath}`
                        : `Could not read results: ${error.message}`,
                });
            }
            return;
        }
        if (url.pathname === "/api/health") {
            sendJson(response, 200, {
                ok: true,
                resultsPath,
                resultsAvailable: fs.existsSync(resultsPath),
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
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main().catch((error) => {
        console.error(`ERROR: ${error.stack || error.message || error}`);
        process.exitCode = 1;
    });
}
