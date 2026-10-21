import React from "react";

/** One-line text for a notification; the payload holds only owner-visible facts. */
export function describeNotification(item) {
    const p = item?.payload ?? {};
    const pkg = p.packageName || p.packageId ? `${p.packageName ?? p.packageId}${p.semver ? `@${p.semver}` : ""}` : "";
    const session = p.sessionId ? ` · session ${p.sessionId}` : "";
    if (item?.kind === "package_review") {
        const state = p.decision === "approved" && p.approvedNotActive ? "approved, not active" : p.decision;
        return `Review: ${pkg} ${state}${p.reason ? ` — ${p.reason}` : ""}`;
    }
    if (item?.kind === "cron_precheck_recovered") {
        return `Precheck ${p.precheck} recovered${pkg ? ` (${pkg})` : ""}${session} after ${p.brokenOccurrences ?? "?"} broken run(s)`;
    }
    const repeats = item?.occurrences > 1 ? ` · ${item.occurrences} times` : "";
    return `Precheck ${p.precheck} broken (${p.outcome})${pkg ? ` · ${pkg}` : ""}${session}${repeats} — ${p.summary ?? ""}`;
}

export function MyNotifications({ transport }) {
    const [items, setItems] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        let live = true;
        setError(null);
        Promise.resolve().then(() => transport.listMyNotifications({}))
            .then(value => { if (live) setItems(value); }, (e) => { if (live) setError(e?.message || String(e)); });
        return () => { live = false; };
    }, [transport, revision]);
    const markRead = async (ids) => {
        try { await transport.markNotificationsRead(ids); refresh(); }
        catch (e) { setError(e?.message || String(e)); }
    };
    const unread = (items || []).filter(item => !item.readAt).length;
    return React.createElement("section", { "aria-label": "My notifications", className: "ps-notifications" },
        React.createElement("div", null,
            React.createElement("button", { type: "button", onClick: refresh }, "Refresh"),
            React.createElement("button", { type: "button", disabled: unread === 0, onClick: () => markRead(null) }, "Mark all read")),
        error ? React.createElement("p", { role: "alert" }, `Notifications unavailable: ${error}`) : null,
        !items && !error ? React.createElement("p", { role: "status" }, "Loading notifications…") : null,
        items && items.length === 0 ? React.createElement("p", null, "No notifications.") : null,
        (items || []).map(item => React.createElement("article", {
            key: item.id, className: `ps-notification is-${item.kind}${item.readAt ? "" : " is-unread"}`,
        },
            React.createElement("p", null, describeNotification(item)),
            React.createElement("small", null, new Date(item.notifiedAt).toLocaleString()),
            item.readAt ? null : React.createElement("button", { type: "button", onClick: () => markRead([item.id]) }, "Mark read"))));
}
