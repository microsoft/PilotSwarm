import React from "react";
import { selectUnplacedSteeringReceipts } from "pilotswarm/ui-core";
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
