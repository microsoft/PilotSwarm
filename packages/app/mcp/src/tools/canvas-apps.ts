import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, withToolErrors } from "../util/respond.js";

/**
 * Canvas app registry tools (issue 181).
 *
 * Web-mode only: every call rides the portal's /api/v1 canvas-app ops, so the
 * caller's own credential decides what it may see (private apps) and change
 * (owner, contributor, admin). This process adds no privilege of its own. A
 * private app the caller may not see answers NOT_FOUND.
 *
 * Deliberately absent: the per-canvas workspace approval. That decision is
 * made by a person in the portal, never by an agent or a script.
 */
export function registerCanvasAppTools(server: McpServer, ctx: ServerContext) {
    const web = ctx.web;
    if (!web) return;
    // The web client ignores owner/admin arguments: the server derives both
    // from the caller's credential.
    const mgmt: any = web;
    const copy = {
        name: z.string().min(1).describe("App name, e.g. release-signoff"),
        scope: z.enum(["shared", "user"]).optional().describe("Which same-named copy: default your private one, then the shared one"),
        owner_provider: z.string().optional().describe("Unrestricted admin only: another user's private copy (with owner_subject)"),
        owner_subject: z.string().optional(),
    };
    const target = (a: any) => ({
        name: a.name,
        ...(a.scope ? { scope: a.scope } : {}),
        ...(a.owner_provider && a.owner_subject ? { ownerProvider: a.owner_provider, ownerSubject: a.owner_subject } : {}),
    });
    const op = (name: string, args: Record<string, unknown>) => mgmt[name](args);

    server.registerTool("list_canvas_apps", {
        title: "List Canvas Apps",
        description: "Canvas apps visible to this credential: shared apps, your private apps, and (unrestricted admin) everyone's. Each row has the active version and its card.",
        inputSchema: {},
    }, withToolErrors(async () => {
        const apps = await op("listCanvasApps", {});
        return jsonResult({ count: Array.isArray(apps) ? apps.length : 0, apps });
    }));

    server.registerTool("search_canvas_apps", {
        title: "Search Canvas Apps",
        description: "Ranked search over canvas app names, tags and descriptions, limited to what this credential may see.",
        inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() },
    }, withToolErrors(async ({ query, limit }) => jsonResult({ apps: await op("searchCanvasApps", { query, ...(limit ? { limit } : {}) }) })));

    server.registerTool("get_canvas_app", {
        title: "Get Canvas App",
        description: "One canvas app: description, owner, versions with their cards (interface, contract, workspace), and your rights.",
        inputSchema: copy,
    }, withToolErrors(async (a) => jsonResult({ app: await op("getCanvasApp", target(a)) })));

    server.registerTool("get_canvas_app_html", {
        title: "Get Canvas App Page",
        description: "One version's page (the active one unless version is given), as text with its sha256.",
        inputSchema: { ...copy, version: z.string().optional() },
    }, withToolErrors(async (a) => jsonResult(await op("getCanvasAppHtml", { ...target(a), ...(a.version ? { version: a.version } : {}) }))));

    server.registerTool("publish_canvas_app_html", {
        title: "Publish Canvas App Page",
        description: "Publish a page (≤ 900 KB, with a CANVAS-APP-MANIFEST carrying an interface block) as a version of an app. Private unless scope is shared. The same bytes again change nothing.",
        inputSchema: {
            name: z.string().min(1), html: z.string().min(1),
            description: z.string().optional().describe("One sentence saying WHEN to use the app"),
            tags: z.array(z.string()).optional(), scope: z.enum(["shared", "user"]).optional(),
            version: z.string().optional().describe("SemVer; default the manifest's, else the next patch"),
        },
    }, withToolErrors(async (a) => jsonResult(await op("uploadCanvasApp", a))));

    server.registerTool("set_canvas_app_scope", {
        title: "Share or Unshare Canvas App",
        description: "Make an app shared (everyone) or private. Owner or admin. Making it private removes its contributors.",
        inputSchema: { ...copy, target_scope: z.enum(["shared", "user"]) },
    }, withToolErrors(async (a) => jsonResult(await op("setCanvasAppScope", { ...target(a), targetScope: a.target_scope }))));

    server.registerTool("set_canvas_app_enabled", {
        title: "Enable or Disable Canvas App",
        description: "Enable or disable an app. Owner, contributor or admin.",
        inputSchema: { ...copy, enabled: z.boolean() },
    }, withToolErrors(async (a) => jsonResult(await op("setCanvasAppEnabled", { ...target(a), enabled: a.enabled }))));

    server.registerTool("set_canvas_app_metadata", {
        title: "Describe Canvas App",
        description: "Change an app's description or tags. Owner, contributor or admin.",
        inputSchema: { ...copy, description: z.string().optional(), tags: z.array(z.string()).optional() },
    }, withToolErrors(async (a) => jsonResult(await op("setCanvasAppMetadata", { ...target(a), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.tags ? { tags: a.tags } : {}) }))));

    server.registerTool("pin_canvas_app_version", {
        title: "Pin Canvas App Version",
        description: "Make a published version the active one. Owner, contributor or admin.",
        inputSchema: { ...copy, version: z.string().min(1) },
    }, withToolErrors(async (a) => jsonResult(await op("pinCanvasAppVersion", { ...target(a), version: a.version }))));

    server.registerTool("delete_canvas_app", {
        title: "Delete Canvas App",
        description: "Delete an app with every version. Owner or admin. Canvases already drawn keep working. Needs confirm: true.",
        inputSchema: { ...copy, confirm: z.literal(true) },
    }, withToolErrors(async (a) => jsonResult(await op("deleteCanvasApp", target(a)))));

    server.registerTool("manage_canvas_app_contributors", {
        title: "Canvas App Contributors",
        description: "List, add or remove contributors of a SHARED app. Adding and removing: owner or admin.",
        inputSchema: {
            name: z.string().min(1), action: z.enum(["list", "add", "remove"]),
            provider: z.string().optional(), subject: z.string().optional(),
        },
    }, withToolErrors(async (a) => {
        if (a.action === "list") return jsonResult({ contributors: await op("listCanvasAppEditors", { name: a.name }) });
        const user = { provider: String(a.provider ?? ""), subject: String(a.subject ?? "") };
        return jsonResult(await op(a.action === "add" ? "grantCanvasAppEditor" : "revokeCanvasAppEditor", { name: a.name, user }));
    }));

    server.registerTool("export_canvas_app", {
        title: "Export Canvas App",
        description: "A deterministic .tar.gz of every version and the card, with no owner, scope or user/session ids, as base64 — for importing into another PilotSwarm.",
        inputSchema: copy,
    }, withToolErrors(async (a) => jsonResult(await op("exportCanvasApp", target(a)))));

    server.registerTool("import_canvas_app", {
        title: "Import Canvas App",
        description: "Import an exported archive (base64, ≤ 20 MB) as your app, private unless scope is shared. The whole archive is checked first; a version that exists with other bytes fails alone.",
        inputSchema: { content_base64: z.string().min(1), scope: z.enum(["shared", "user"]).optional() },
    }, withToolErrors(async (a) => jsonResult(await op("importCanvasApp", { contentBase64: a.content_base64, ...(a.scope ? { scope: a.scope } : {}) }))));

    server.registerTool("get_canvas_app_loads", {
        title: "Canvas App Loads",
        description: "Loads of an app, newest first: time, session, user, version, and the 30-day total. Owner or unrestricted admin.",
        inputSchema: {
            ...copy, limit: z.number().int().min(1).max(500).optional(),
            since: z.string().optional().describe("ISO time: loads at or after"), until: z.string().optional().describe("ISO time: loads before"),
            cursor_at: z.string().optional(), cursor_id: z.string().optional(),
        },
    }, withToolErrors(async (a) => jsonResult(await op("getCanvasAppLoads", {
        ...target(a), ...(a.limit ? { limit: a.limit } : {}),
        ...(a.since ? { since: a.since } : {}), ...(a.until ? { until: a.until } : {}),
        ...(a.cursor_at && a.cursor_id ? { cursorAt: a.cursor_at, cursorId: a.cursor_id } : {}),
    }))));

    server.registerTool("prune_canvas_apps", {
        title: "Prune Canvas App Registry",
        description: "Remove expired load rows, abandoned uploads and deleted apps' bytes. Unrestricted admin. Safe to run any time; a storage failure is retried next time.",
        inputSchema: {},
    }, withToolErrors(async () => jsonResult(await op("pruneCanvasApps", {}))));

    server.registerTool("get_canvas_label", {
        title: "Get Canvas Transition Label",
        description: "The canvas app transition (issue 181): whether the canvas now on a session's slot is handled as on main (an old app's page, or one drawn before the registry) while the deployment's transition is on. Read only.",
        inputSchema: { session_id: z.string().min(1), slot: z.number().int().min(1).max(5).optional() },
    }, withToolErrors(async (a) => jsonResult(await op("getCanvasRevisionLabel", { sessionId: a.session_id, ...(a.slot ? { slot: a.slot } : {}) }))));

    server.registerTool("migrate_legacy_canvas_apps", {
        title: "Migrate Legacy Canvas Apps",
        description: "One-time import of the legacy apps/* facts into the registry as shared apps. Unrestricted admin. Dry run unless dry_run is false; safe to run again. While the canvas app transition (PILOTSWARM_CANVAS_LEGACY_MODE) is on, applying it is refused (CANVAS_LEGACY_MODE_ON) and a dry run says so in applyBlocked.",
        inputSchema: { dry_run: z.boolean().optional() },
    }, withToolErrors(async (a) => jsonResult(await op("migrateLegacyCanvasApps", { dryRun: a.dry_run !== false }))));
}
