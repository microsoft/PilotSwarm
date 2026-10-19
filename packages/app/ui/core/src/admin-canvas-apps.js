/**
 * Admin Console → Canvas Apps view-models (issue 181 R23, R29). Pure: the
 * selector passes the admin slice and the viewer; the portal and the TUI
 * render what comes back.
 */

import { formatDisplayDateTime } from "./formatting.js";

function dateText(value) {
    if (!value) return "—";
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

function sizeText(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function shapeText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

function personLabel(displayName, email, principal) {
    return displayName || email || principal?.subject || "unknown";
}

/** The stable id of one app copy in the settings tree. */
export function canvasAppRowId(app) {
    const scope = app?.scope === "shared" ? "shared" : "user";
    return `capp:${scope}:${scope === "shared" ? "" : (app?.owner?.subject ?? app?.ownerSubject ?? "")}:${app?.name ?? ""}`;
}

/** The selector-friendly target of one app copy. */
export function canvasAppSelector(app) {
    const scope = app?.scope === "shared" ? "shared" : "user";
    return {
        name: String(app?.name ?? ""),
        scope,
        ownerProvider: scope === "shared" ? null : (app?.owner?.provider ?? app?.ownerProvider ?? null),
        ownerSubject: scope === "shared" ? null : (app?.owner?.subject ?? app?.ownerSubject ?? null),
    };
}

/** Op arguments that name exactly this copy. */
export function canvasAppTargetArgs(selected) {
    if (!selected?.name) return {};
    return {
        name: selected.name,
        scope: selected.scope === "shared" ? "shared" : "user",
        ...(selected.scope !== "shared" && selected.ownerProvider && selected.ownerSubject
            ? { ownerProvider: selected.ownerProvider, ownerSubject: selected.ownerSubject }
            : {}),
    };
}

function sameCopy(app, selected) {
    if (!selected?.name || app?.name !== selected.name) return false;
    const scope = app.scope === "shared" ? "shared" : "user";
    if (scope !== selected.scope) return false;
    if (scope === "shared" || !selected.ownerSubject) return true;
    return app.owner?.provider === selected.ownerProvider && app.owner?.subject === selected.ownerSubject;
}

/**
 * The interface card (R23): actions with their fields, KV keys, requests with
 * what each expects back, events, and the workspace warning.
 */
export function canvasAppInterfaceCard(card) {
    const source = card && typeof card === "object" ? card : {};
    const iface = source.interface && typeof source.interface === "object" ? source.interface : {};
    const contract = source.responseContract && typeof source.responseContract === "object" ? source.responseContract : null;
    const actions = contract?.actions && typeof contract.actions === "object"
        ? Object.entries(contract.actions).map(([name, fields]) => ({
            name,
            fields: fields && typeof fields === "object"
                ? Object.entries(fields).map(([field, type]) => {
                    const text = String(type ?? "");
                    const optional = text.endsWith("?");
                    return { name: field, type: optional ? text.slice(0, -1) : text, optional };
                })
                : [],
        }))
        : [];
    const keys = (Array.isArray(iface.keys) ? iface.keys : []).map((entry) => ({
        key: String(entry?.key ?? ""),
        writer: entry?.writer || null,
        shape: shapeText(entry?.shape),
        note: entry?.note ? String(entry.note) : "",
    })).filter((entry) => entry.key);
    const requests = (Array.isArray(iface.requests) ? iface.requests : []).map((entry) => ({
        op: String(entry?.op ?? ""),
        args: shapeText(entry?.args),
        result: shapeText(entry?.result),
        note: entry?.note ? String(entry.note) : "",
    })).filter((entry) => entry.op);
    const events = (Array.isArray(iface.events) ? iface.events : []).map((entry) => ({
        key: String(entry?.key ?? ""),
        shape: shapeText(entry?.shape),
        note: entry?.note ? String(entry.note) : "",
    })).filter((entry) => entry.key);
    const ws = source.workspace && typeof source.workspace === "object" ? source.workspace : null;
    const workspace = ws
        ? {
            read: Array.isArray(ws.read) ? ws.read.map(String) : [],
            write: Array.isArray(ws.write) ? ws.write.map(String) : [],
            watch: Boolean(ws.watch),
            commands: ws.commands && typeof ws.commands === "object" ? Object.keys(ws.commands) : [],
        }
        : null;
    const workspaceWarning = workspace
        ? [
            "This app asks for access to the session's workspace folders",
            workspace.write.length ? "and may change files there" : "to read files there",
            workspace.commands.length ? `and to run ${workspace.commands.length === 1 ? "a command" : `${workspace.commands.length} commands`} (${workspace.commands.join(", ")})` : "",
        ].filter(Boolean).join(" ") + ". The session owner approves it on each canvas before it runs."
        : null;
    return {
        actions, keys, requests, events,
        notes: iface.notes ? String(iface.notes) : "",
        workspace,
        workspaceWarning,
        empty: !actions.length && !keys.length && !requests.length && !events.length,
    };
}

/**
 * Tree rows and the view-model. `isMine(app)` and `passesOwnerFilter(app)`
 * come from the selector so packages and apps use one rule.
 */
export function buildCanvasAppsView(admin, { section, isMine, passesOwnerFilter, resourceAdmin }) {
    const apps = admin?.canvasApps || {};
    const list = Array.isArray(apps.list) ? apps.list : [];
    const selected = apps.selected || null;
    const row = (app) => ({
        id: canvasAppRowId(app),
        kind: "canvasApp",
        label: app.name,
        name: app.name,
        scope: app.scope === "shared" ? "shared" : "user",
        owner: app.owner ?? null,
        ownerLabel: personLabel(app.ownerDisplayName, app.ownerEmail, app.owner),
        version: app.version || null,
        enabled: app.enabled !== false,
        canManage: Boolean(app.canManage),
        canEdit: Boolean(app.canEdit),
        selector: canvasAppSelector(app),
        selected: section === "canvasApps" && sameCopy(app, selected),
    });
    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const shared = list.filter((app) => app.scope === "shared").sort(byName).map(row);
    const mine = list.filter((app) => app.scope !== "shared" && isMine(app)).sort(byName).map(row);
    const others = list.filter((app) => app.scope !== "shared" && !isMine(app) && passesOwnerFilter(app)).sort(byName).map(row);

    let detail = null;
    if (selected?.name) {
        const summary = list.find((app) => sameCopy(app, selected)) || null;
        const d = apps.detail || null;
        const source = d || summary;
        const versions = Array.isArray(d?.versions) ? d.versions : [];
        const activeId = d?.activeVersionId ?? summary?.activeVersionId ?? null;
        const active = versions.find((v) => v.versionId === activeId) || null;
        const card = active?.card || summary?.card || null;
        const editors = Array.isArray(apps.editors) ? apps.editors : [];
        const loads = apps.loads || {};
        const preview = apps.preview || {};
        const canManage = Boolean(summary?.canManage ?? d?.canManage);
        const canEdit = Boolean(summary?.canEdit ?? d?.canEdit) || canManage;
        const scope = (source?.scope ?? selected.scope) === "shared" ? "shared" : "user";
        detail = {
            name: selected.name,
            selector: canvasAppSelector(source || selected),
            loading: Boolean(apps.detailLoading),
            error: apps.detailError || null,
            found: Boolean(source),
            scope,
            scopeLabel: scope === "shared" ? "Shared" : "Private",
            ownerLabel: source ? personLabel(source.ownerDisplayName, source.ownerEmail, source.owner) : "",
            enabled: source ? source.enabled !== false : true,
            version: active?.version || summary?.version || null,
            tags: Array.isArray(source?.tags) ? source.tags : [],
            description: typeof source?.description === "string" ? source.description : "",
            createdText: dateText(source?.createdAt),
            updatedText: dateText(source?.updatedAt),
            shadowed: Boolean(summary?.shadowed),
            canManage,
            canEdit,
            interfaceCard: canvasAppInterfaceCard(card),
            versions: versions.map((v) => ({
                version: v.version,
                sha12: String(v.sha256 || "").slice(0, 12),
                sizeText: sizeText(v.sizeBytes),
                dateText: dateText(v.createdAt),
                createdBy: v.createdBy || null,
                active: v.versionId === activeId,
            })),
            contributors: [
                ...(source?.owner ? [{ role: "owner", label: personLabel(source.ownerDisplayName, source.ownerEmail, source.owner), subject: source.owner.subject }] : []),
                ...editors.map((e) => ({ role: "contributor", label: personLabel(e.displayName, e.email, e), subject: e.subject, provider: e.provider })),
            ],
            loads: {
                loading: Boolean(loads.loading),
                // Only the owner and admins may read loads; others see none.
                visible: !loads.hidden && (canManage || Boolean(resourceAdmin)),
                error: loads.hidden ? null : (loads.error || null),
                total30d: Number.isFinite(loads.total30d) ? loads.total30d : null,
                total30dText: Number.isFinite(loads.total30d) ? `${loads.total30d.toLocaleString("en-US")} in the last 30 days` : null,
                rows: (Array.isArray(loads.rows) ? loads.rows : []).map((l) => ({
                    id: l.loadId,
                    whenText: formatDisplayDateTime(l.loadedAt),
                    userLabel: personLabel(l.userDisplayName, l.userEmail, l.user),
                    version: l.version,
                    sessionId: l.sessionId,
                })),
            },
            preview: {
                open: Boolean(preview.loading || preview.html !== null || preview.error),
                loading: Boolean(preview.loading),
                error: preview.error || null,
                html: preview.html ?? null,
                version: preview.version || null,
                sha256: preview.sha256 || null,
            },
            actionPending: apps.action?.pending || null,
            actionError: apps.action?.error || null,
            notice: apps.action?.notice || null,
        };
    }

    const dialog = apps.addDialog || {};
    return {
        rows: { shared, mine, others },
        loading: Boolean(apps.loading),
        error: apps.error || null,
        empty: list.length === 0 && !apps.loading,
        total: shared.length + mine.length + others.length,
        detail,
        addDialog: {
            open: Boolean(dialog.open),
            kind: dialog.kind === "archive" ? "archive" : "html",
            scope: dialog.scope === "shared" ? "shared" : "user",
            fileName: dialog.fileName || "",
            hasContent: Boolean(dialog.content),
            name: dialog.name || "",
            description: dialog.description || "",
            tags: dialog.tags || "",
            version: dialog.version || "",
            submitting: Boolean(dialog.submitting),
            error: dialog.error || null,
            canSubmit: !dialog.submitting && Boolean(dialog.content) && (dialog.kind === "archive" || Boolean(String(dialog.name || "").trim())),
        },
    };
}

/** The canvas toolbar's "Publish as app" dialog (R25). */
export function selectCanvasPublishDialog(state) {
    const d = state?.canvasPublish || {};
    const check = d.check || null;
    return {
        open: Boolean(d.open),
        sessionId: d.sessionId || null,
        slot: d.slot || 1,
        name: d.name || "",
        description: d.description || "",
        tags: d.tags || "",
        version: d.version || "",
        scope: d.scope === "shared" ? "shared" : "user",
        checking: Boolean(d.checking),
        check: check
            ? {
                ok: Boolean(check.ok),
                text: check.ok
                    ? `Manifest check passed (${sizeText(check.sizeBytes)})`
                    : `Manifest check failed: ${check.error || "unknown error"}`,
                workspace: Boolean(check.workspace),
            }
            : null,
        submitting: Boolean(d.submitting),
        error: d.error || null,
        result: d.result
            ? {
                text: `${d.result.status === "unchanged" ? "Already published as" : "Published"} ${d.result.name || d.name}@${d.result.version} (${d.result.scope === "shared" ? "shared" : "private"})`,
            }
            : null,
        canSubmit: Boolean(d.open && !d.submitting && !d.checking && check?.ok && String(d.name || "").trim()),
    };
}

/**
 * Whether the canvas toolbar offers "Publish as app" (R25): to the active
 * session's owner only. With no sign-in (a local single-user portal) the
 * viewer owns the ownerless sessions it created.
 */
export function selectCanvasPublishAvailable(state) {
    const sessionId = state?.sessions?.activeSessionId || null;
    if (!sessionId) return false;
    const session = state?.sessions?.byId?.[sessionId];
    if (!session || session.isGroup || session.isSystem) return false;
    const principal = state?.auth?.principal || null;
    const owner = session.owner || null;
    if (!principal?.subject) return !owner?.subject;
    return Boolean(owner?.subject) && owner.subject === principal.subject
        && String(owner.provider || "") === String(principal.provider || "");
}
