/**
 * `pilotswarm apps …` — the canvas app registry CLI (issue 181).
 *
 * Web API mode only: the deployment's own authorization decides what you can
 * see and change; the CLI needs no datastore credentials. Sign in once with
 * `pilotswarm auth login --api-url <url>`, then pass --api-url or set
 * PILOTSWARM_API_URL. Scripts and CI can use PILOTSWARM_API_TOKEN instead.
 *
 *   pilotswarm apps list | search <words> | show <name>
 *   pilotswarm apps push <file.html> --name <name> [--shared] [--version <v>] [--description <text>]
 *   pilotswarm apps pull <name> [--version <v>] [--output <file>]
 *   pilotswarm apps export <name> [--output <file>] | import <file> [--shared]
 *   pilotswarm apps describe <name> [--description <text>] [--tags a,b]
 *   pilotswarm apps share <name> | unshare <name> | enable <name> | disable <name>
 *   pilotswarm apps pin <name>@<version> | rm <name> --yes
 *   pilotswarm apps editors <name> [add|remove <provider>:<subject>]
 *   pilotswarm apps loads <name> [--limit <n>]  [--since/--until <iso>] [--cursor <at>/<id>]
 *   pilotswarm apps prune
 *   pilotswarm apps migrate-legacy [--apply]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PilotSwarmManagementClient } from "pilotswarm-sdk";
import { bootstrapApiAuth } from "./auth/cli.js";

export const APPS_USAGE = `pilotswarm apps — manage canvas apps

Usage:
  pilotswarm apps list [--json]
  pilotswarm apps search <words> [--json]
  pilotswarm apps show <name> [--shared|--user] [--json]
  pilotswarm apps push <file.html> --name <name> [--shared] [--version <v>] [--description <text>] [--tags a,b]
  pilotswarm apps pull <name> [--version <v>] [--output <file>] [--shared|--user]
  pilotswarm apps export <name> [--output <file>] [--shared|--user]
  pilotswarm apps import <file.tar.gz> [--shared]
  pilotswarm apps describe <name> [--description <text>] [--tags a,b] [--shared|--user]
                                                       change only the description and tags; no new version
  pilotswarm apps share <name> | unshare <name>
  pilotswarm apps enable <name> | disable <name> [--shared|--user]
  pilotswarm apps pin <name>@<version> [--shared|--user]
  pilotswarm apps editors <name> [--json]
  pilotswarm apps editors add|remove <name> <provider>:<subject>
  pilotswarm apps loads <name> [--limit <n>] [--since <iso>] [--until <iso>] [--cursor <at>/<id>] [--json]
  pilotswarm apps rm <name> --yes [--shared|--user]
  pilotswarm apps prune [--json]                       unrestricted admin: expired loads, abandoned uploads, deleted apps' bytes
  pilotswarm apps migrate-legacy [--apply] [--json]

Connection (web API only):
  --api-url <url>   defaults to PILOTSWARM_API_URL
                    sign in first: pilotswarm auth login --api-url <url>
                    (or set PILOTSWARM_API_TOKEN for scripts and CI)

Apps are private unless you pass --shared. --shared/--user also pick which
same-named copy a command targets (default: yours, then the shared one).`;

export function parseAppsArgs(argv) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--shared") flags.scope = "shared";
        else if (arg === "--user") flags.scope = "user";
        else if (arg === "--json") flags.json = true;
        else if (arg === "--yes" || arg === "-y") flags.yes = true;
        else if (arg === "--apply") flags.apply = true;
        else if (arg === "--api-url") flags.apiUrl = argv[++i];
        else if (arg === "--name") flags.name = argv[++i];
        else if (arg === "--version") flags.version = argv[++i];
        else if (arg === "--description") flags.description = argv[++i];
        else if (arg === "--tags") flags.tags = String(argv[++i] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
        else if (arg === "--limit") flags.limit = Number(argv[++i]);
        else if (arg === "--since") flags.since = argv[++i];
        else if (arg === "--until") flags.until = argv[++i];
        else if (arg === "--cursor") flags.cursor = argv[++i];
        else if (arg === "--output" || arg === "-o") flags.output = argv[++i];
        else if (arg === "--help" || arg === "-h") flags.help = true;
        else positional.push(arg);
    }
    return { flags, positional };
}

function apiUrlOf(flags) {
    const apiUrl = String(flags.apiUrl || process.env.PILOTSWARM_API_URL || "").trim().replace(/\/+$/, "");
    if (!apiUrl) throw new Error("no deployment configured — pass --api-url <url> or set PILOTSWARM_API_URL");
    return apiUrl;
}

async function connect(flags, deps) {
    if (deps?.client) return { client: deps.client, close: async () => {} };
    const apiUrl = apiUrlOf(flags);
    const { getAccessToken } = await bootstrapApiAuth(apiUrl, { interactive: true });
    const client = new PilotSwarmManagementClient({ apiUrl, getAccessToken });
    await client.start();
    return { client, close: () => client.stop().catch(() => {}) };
}

function principal(text) {
    const at = String(text ?? "").indexOf(":");
    if (at <= 0) throw new Error(`expected <provider>:<subject>, got "${text}"`);
    return { provider: text.slice(0, at), subject: text.slice(at + 1) };
}

/**
 * Run one `pilotswarm apps` command. `deps.client` and `deps.out`/`deps.err`
 * let tests drive it against a stub client without a deployment.
 */
export async function runAppsCommand(argv, deps = {}) {
    const out = deps.out ?? ((line) => console.log(line));
    const err = deps.err ?? ((line) => console.error(line));
    const { flags, positional } = parseAppsArgs(argv);
    const [command, ...rest] = positional;
    if (flags.help || !command) {
        out(APPS_USAGE);
        return command ? 0 : 1;
    }
    const sel = flags.scope ? { scope: flags.scope } : {};
    const print = (value, human) => {
        if (flags.json || !human) out(JSON.stringify(value, null, 2));
        else out(human(value));
    };
    const needName = (name, usage) => {
        if (!name) throw new Error(`usage: pilotswarm apps ${usage}`);
        return name;
    };
    const { client, close } = await connect(flags, deps);
    try {
        switch (command) {
            case "list": {
                const apps = await client.listCanvasApps({});
                print(apps, (rows) => rows.map((a) => `${a.scope === "shared" ? "S" : "P"}  ${a.name}${a.version ? `@${a.version}` : ""}${a.enabled ? "" : "  (disabled)"}  ${a.description ?? ""}`).join("\n") || "(no apps)");
                return 0;
            }
            case "search": {
                const hits = await client.searchCanvasApps({ query: rest.join(" "), ...(flags.limit ? { limit: flags.limit } : {}) });
                print(hits, (rows) => rows.map((a) => `${a.name}${a.version ? `@${a.version}` : ""}  ${a.description ?? ""}`).join("\n") || "(no match)");
                return 0;
            }
            case "show": {
                const app = await client.getCanvasApp({ name: needName(rest[0], "show <name>"), ...sel });
                print(app, (a) => [
                    `${a.name}  (${a.scope === "shared" ? "shared" : "private"}${a.enabled ? "" : ", disabled"})`,
                    a.description,
                    `versions: ${a.versions.map((v) => `${v.version}${v.versionId === a.activeVersionId ? "*" : ""}`).join(", ")}`,
                ].join("\n"));
                return 0;
            }
            case "push": {
                const file = needName(rest[0], "push <file.html> --name <name>");
                const name = needName(flags.name, "push <file.html> --name <name>");
                const html = fs.readFileSync(path.resolve(file), "utf8");
                const result = await client.uploadCanvasApp({
                    html, name, ...(flags.scope ? { scope: flags.scope } : {}),
                    ...(flags.version ? { version: flags.version } : {}),
                    ...(flags.description ? { description: flags.description } : {}),
                    ...(flags.tags ? { tags: flags.tags } : {}),
                });
                print(result, (r) => `${r.status === "published" ? "published" : "unchanged"} ${name}@${r.version} (${r.scope === "shared" ? "shared" : "private"})`);
                return 0;
            }
            case "pull": {
                const name = needName(rest[0], "pull <name>");
                const page = await client.getCanvasAppHtml({ name, ...sel, ...(flags.version ? { version: flags.version } : {}) });
                const output = flags.output || `${name}@${page.version}.html`;
                fs.writeFileSync(output, page.html);
                print({ ...page, html: undefined, output }, () => `wrote ${output} (${page.version}, sha256 ${page.sha256.slice(0, 12)})`);
                return 0;
            }
            case "export": {
                const name = needName(rest[0], "export <name>");
                const archive = await client.exportCanvasApp({ name, ...sel });
                const output = flags.output || archive.filename;
                fs.writeFileSync(output, Buffer.from(archive.contentBase64, "base64"));
                print({ filename: archive.filename, sha256: archive.sha256, sizeBytes: archive.sizeBytes, output }, () => `wrote ${output} (sha256 ${archive.sha256.slice(0, 12)})`);
                return 0;
            }
            case "import": {
                const file = needName(rest[0], "import <file.tar.gz>");
                const contentBase64 = fs.readFileSync(path.resolve(file)).toString("base64");
                const result = await client.importCanvasApp({ contentBase64, ...(flags.scope ? { scope: flags.scope } : {}) });
                print(result, (r) => [`${r.name} (${r.scope === "shared" ? "shared" : "private"})`, ...r.versions.map((v) => `  ${v.version}: ${v.status}${v.code ? ` (${v.code})` : ""}`)].join("\n"));
                return result.versions.some((v) => v.status === "failed") ? 2 : 0;
            }
            case "describe": {
                const name = needName(rest[0], "describe <name> --description <text> | --tags a,b");
                if (!flags.description && !flags.tags) throw new Error("usage: pilotswarm apps describe <name> [--description <text>] [--tags a,b]");
                await client.setCanvasAppMetadata({
                    name, ...sel,
                    ...(flags.description ? { description: flags.description } : {}),
                    ...(flags.tags ? { tags: flags.tags } : {}),
                });
                out(`${name}: ${[flags.description ? "description" : null, flags.tags ? "tags" : null].filter(Boolean).join(" and ")} updated`);
                return 0;
            }
            case "share":
            case "unshare": {
                const name = needName(rest[0], `${command} <name>`);
                await client.setCanvasAppScope({ name, scope: command === "share" ? "user" : "shared", targetScope: command === "share" ? "shared" : "user" });
                out(`${name} is now ${command === "share" ? "shared" : "private"}`);
                return 0;
            }
            case "enable":
            case "disable": {
                const name = needName(rest[0], `${command} <name>`);
                await client.setCanvasAppEnabled({ name, enabled: command === "enable", ...sel });
                out(`${name} ${command}d`);
                return 0;
            }
            case "pin": {
                const spec = needName(rest[0], "pin <name>@<version>");
                const at = spec.indexOf("@");
                if (at <= 0) throw new Error("usage: pilotswarm apps pin <name>@<version>");
                await client.pinCanvasAppVersion({ name: spec.slice(0, at), version: spec.slice(at + 1), ...sel });
                out(`${spec} is active`);
                return 0;
            }
            case "editors": {
                if (rest[0] === "add" || rest[0] === "remove") {
                    const name = needName(rest[1], `editors ${rest[0]} <name> <provider>:<subject>`);
                    const user = principal(rest[2]);
                    await (rest[0] === "add" ? client.grantCanvasAppEditor({ name, user }) : client.revokeCanvasAppEditor({ name, user }));
                    out(`${rest[0] === "add" ? "added" : "removed"} ${user.provider}:${user.subject} ${rest[0] === "add" ? "to" : "from"} ${name}`);
                    return 0;
                }
                const editors = await client.listCanvasAppEditors({ name: needName(rest[0], "editors <name>") });
                print(editors, (rows) => rows.map((e) => `${e.provider}:${e.subject}${e.email ? `  ${e.email}` : ""}`).join("\n") || "(no contributors)");
                return 0;
            }
            case "loads": {
                let cursor = {};
                if (flags.cursor) {
                    const at = String(flags.cursor).lastIndexOf("/");
                    if (at <= 0) throw new Error("usage: --cursor <cursorAt>/<cursorId> (printed as 'next:' by the previous page)");
                    cursor = { cursorAt: flags.cursor.slice(0, at), cursorId: flags.cursor.slice(at + 1) };
                }
                const page = await client.getCanvasAppLoads({
                    name: needName(rest[0], "loads <name>"), ...sel,
                    ...(flags.limit ? { limit: flags.limit } : {}),
                    ...(flags.since ? { since: flags.since } : {}), ...(flags.until ? { until: flags.until } : {}),
                    ...cursor,
                });
                print(page, (p) => [
                    `${p.total30d} loads in the last 30 days`,
                    ...p.rows.map((r) => `${new Date(r.loadedAt).toISOString()}  ${r.version}  ${r.userEmail || (r.user ? `${r.user.provider}:${r.user.subject}` : "-")}  ${r.sessionId}`),
                    ...(p.nextCursor ? [`next: --cursor ${p.nextCursor.loadedAt}/${p.nextCursor.loadId}`] : []),
                ].join("\n"));
                return 0;
            }
            case "rm": {
                const name = needName(rest[0], "rm <name> --yes");
                if (!flags.yes) { err("refusing to delete without --yes (every version is removed)"); return 1; }
                await client.deleteCanvasApp({ name, ...sel });
                out(`deleted ${name}`);
                return 0;
            }
            case "prune": {
                const result = await client.pruneCanvasApps({});
                print(result, (r) => `${r.loadsRemoved ?? 0} load rows, ${r.pendingRemoved ?? 0} abandoned uploads, ${r.spacesPurged ?? 0} deleted apps' bytes removed${r.failures ? `; ${r.failures} storage failures will be retried` : ""}`);
                return result?.failures ? 2 : 0;
            }
            case "migrate-legacy": {
                const result = await client.migrateLegacyCanvasApps({ dryRun: !flags.apply });
                print(result, (r) => [
                    ...r.lines.map((l) => `${l.name.padEnd(20)} -> ${l.outcome === "skipped" ? `skipped        ${l.reason}` : `shared ${String(l.version).padEnd(7)} owner ${l.owner ? `${l.owner.provider}:${l.owner.subject}` : "(none)"}  ${l.outcome === "migrated" ? "migrated" : "ok"}`}`),
                    r.dryRun ? `dry run: ${r.migrated} to migrate, ${r.skipped} skipped — run again with --apply` : `${r.migrated} migrated, ${r.skipped} skipped`,
                ].join("\n"));
                return 0;
            }
            default:
                err(`unknown command "${command}"`);
                out(APPS_USAGE);
                return 1;
        }
    } finally {
        await close();
    }
}
