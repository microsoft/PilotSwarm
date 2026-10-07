import React from "react";
import { selectUnplacedSteeringReceipts, selectSteeringReceipts } from "pilotswarm/ui-core";
import { useControllerSelector } from "./use-controller-state.js";
import { SteeringReceipt } from "./steering-receipt.js";

export function SteeringArchive({ controller }) {
    const state = useControllerSelector(controller, value => value);
    const [open, setOpen] = React.useState(false);
    const sessionId = state.sessions.activeSessionId;
    const rows = selectUnplacedSteeringReceipts(state);
    const page = state.steering?.bySessionId?.[sessionId]?.page;
    if (!rows.length && !page?.nextCursor && !page?.error) return null;
    return React.createElement("details", { className: "ps-steering-archive",
        onToggle: event => setOpen(event.currentTarget.open) },
    React.createElement("summary", null, `Guidance outside this history page (${rows.length})`),
    open ? React.createElement(React.Fragment, null,
        React.createElement("p", null, "These receipts are not placed in the transcript until their acceptance history is loaded."),
        ...rows.map(message => React.createElement(SteeringReceipt, { key: message.id, message, controller })),
        page?.nextCursor ? React.createElement("p", { role: "status" }, "Partial receipt list. More guidance is available.") : null,
        page?.error ? React.createElement("p", { role: "alert" }, page.error) : null,
        page?.nextCursor ? React.createElement("button", { type: "button", className: "ps-mini-button",
            disabled: page.loading, onClick: () => controller.loadSteeringRequests(sessionId) },
        page.loading ? "Loading guidance..." : "Load more guidance") : null) : null);
}

export function SteeringHistoryDialog({ controller, sessionId, onClose }) {
    const state = useControllerSelector(controller, value => value);
    const rows = selectSteeringReceipts(state, sessionId);
    const page = state.steering?.bySessionId?.[sessionId]?.page;
    return React.createElement("div", { className: "ps-modal-backdrop", onClick: onClose },
        React.createElement("div", { className: "ps-modal", role: "dialog", "aria-modal": true,
            "aria-label": "Guidance history", onClick: event => event.stopPropagation() },
        React.createElement("div", { className: "ps-modal-header" },
            React.createElement("div", { className: "ps-modal-title" }, "Guidance history"),
            React.createElement("button", { type: "button", className: "ps-modal-close", autoFocus: true,
                "aria-label": "Close guidance history", onClick: onClose }, "Close")),
        React.createElement("div", { className: "ps-modal-list" },
            ...rows.map(message => React.createElement(SteeringReceipt, { key: message.id, message, controller })),
            !rows.length ? React.createElement("p", null, "No readable guidance receipts.") : null),
        React.createElement("div", { className: "ps-modal-footer" },
            page?.error ? React.createElement("p", { role: "alert" }, page.error) : null,
            page?.nextCursor ? React.createElement(React.Fragment, null,
                React.createElement("span", { role: "status" }, "Partial receipt list."),
                React.createElement("button", { type: "button", className: "ps-modal-button", disabled: page.loading,
                    onClick: () => controller.loadSteeringRequests(sessionId) },
                page.loading ? "Loading guidance..." : "Load more guidance")) : null)));
}
