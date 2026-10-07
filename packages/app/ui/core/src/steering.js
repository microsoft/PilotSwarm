// Receipts are the authority. Neither SDK acknowledgement nor later assistant
// prose establishes delivery, inclusion, or compliance.
export const STEERING_HELP = "Send guidance at the next supported input boundary. Running actions may still finish.";

export function canReuseSteeringInDraft(receipt) {
    return typeof receipt?.text === "string"
        && ["not_delivered_turn_ended", "not_delivered_turn_stopped", "withdrawn", "delivery_unconfirmed"].includes(receipt.disposition)
        && !(receipt.recoveryFlags?.length)
        && !(receipt.attempts?.items || []).some(attempt => attempt.deliveredAt);
}

export function getSteeringAttemptDisplay(attempt) {
    if (attempt.outcome === "released") return "Not submitted";
    if (attempt.deliveredAt && attempt.deliveryKind === "steering") return "Delivered to current turn";
    if (attempt.deliveredAt && ["queued", "idle"].includes(attempt.deliveryKind)) return "Delivered after the earlier response";
    if (attempt.deliveredAt) return "Delivered (timing unconfirmed)";
    if (attempt.acknowledgedAt && !attempt.deliveredAt) return "Waiting for a safe point";
    return "Delivery unconfirmed";
}

export function emptySteeringSession() {
    return { state: null, windowSeq: 0, receipts: {}, pending: {}, resends: {}, error: null };
}

export function mergeSteeringReceipt(entry = emptySteeringSession(), incoming) {
    if (!incoming?.requestId || !Number.isSafeInteger(incoming.revision)) return entry;
    const previous = entry.receipts[incoming.requestId];
    // An acceptance/body may arrive after a newer body-free projection.
    const newer = !previous || incoming.revision >= previous.revision;
    const receipt = newer ? { ...previous, ...incoming } : {
        ...incoming, ...previous,
        ...(previous.text === undefined && incoming.text !== undefined ? { text: incoming.text } : {}),
    };
    // Broadcast projections never carry viewer-specific actions. Invalidate
    // a stale action grant on revision change until an authorized read repairs it.
    if (previous && (incoming.revision > previous.revision && !incoming.actions
        || incoming.revision < previous.revision && !previous.actions)) {
        receipt.actions = { canWithdraw: false, canSendAsNewMessage: false };
    }
    receipt.actionsRevision = incoming.actions && newer ? incoming.revision : previous?.actionsRevision ?? 0;
    const pending = { ...entry.pending };
    const optimistic = pending[receipt.clientRequestId];
    receipt.rowKey = previous?.rowKey || optimistic?.rowKey || `steering:${receipt.requestId}`;
    delete pending[receipt.clientRequestId];
    return { ...entry, pending, receipts: { ...entry.receipts, [receipt.requestId]: receipt } };
}

export function mergeSteeringWindow(entry = emptySteeringSession(), window, seq) {
    if (!Number.isSafeInteger(seq) || seq <= entry.windowSeq || window?.schemaVersion !== 1) return entry;
    return {
        ...entry,
        windowSeq: seq,
        state: {
            ...entry.state,
            expectedTarget: window.expectedTarget,
            reason: window.reason,
            // A window event grants neither support nor viewer access.
            steerable: entry.state?.supported === true && window.state === "open",
            windowState: window.state,
        },
    };
}

export function getSteeringDisplay(receipt) {
    if (!receipt?.requestId) {
        return {
            label: receipt?.rejected ? "Guidance rejected" : receipt?.error ? "Acceptance unconfirmed" : "Sending guidance...",
            detail: receipt?.error || "Waiting for durable acceptance.",
        };
    }
    const flags = receipt.recoveryFlags || [];
    let label;
    if (receipt.disposition === "delivered_before_stop") label = "Delivered before Stop";
    else if (flags.includes("redelivery_pending")) label = "Delivered earlier — pending redelivery";
    else if (flags.includes("delivered_again")) label = "Delivered again after recovery";
    else if (flags.includes("recovery_unconfirmed")) label = "Delivered earlier — recovery unconfirmed";
    else {
        const labels = {
            accepted: ["submitting", "submitted"].includes(receipt.status) ? "Waiting for a safe point" : "Accepted",
            delivered_current_turn: "Delivered to current turn",
            delivered_after_response: "Delivered after the earlier response",
            delivered_timing_unconfirmed: "Delivered (timing unconfirmed)",
            not_delivered_turn_ended: "Not delivered — turn ended",
            not_delivered_turn_stopped: "Not delivered — turn stopped",
            withdrawn: "Withdrawn",
            delivery_unconfirmed: receipt.closureReason === "stopped" || receipt.eligibility?.reason === "stopped"
                ? "Delivery unconfirmed — turn stopped" : "Delivery uncertain",
            rejected: "Guidance rejected",
        };
        label = labels[receipt.disposition] || "Loading guidance receipt...";
    }
    const details = [];
    if (receipt.disposition === "accepted") details.push(STEERING_HELP);
    if (receipt.disposition === "not_delivered_turn_ended") details.push("The turn ended before this guidance could be sent.");
    if (receipt.disposition === "delivered_timing_unconfirmed") details.push("Delivered before recovery; whether it reached the turn or followed the response is not known.");
    if (receipt.inclusion?.state === "included") details.push("Included in the saved conversation.");
    else if (receipt.inclusion?.state === "not_included") details.push("Not included in the restored conversation.");
    else if (receipt.requestId) details.push("Inclusion unconfirmed.");
    if (receipt.eligibility?.state === "terminal") details.push("Not scheduled for resend.");
    return { label, detail: details.join(" ") };
}

export function getSteeringEligibility({ session, steering, draft = "", attachments = [] }) {
    let reason = "";
    if (!session || session.isGroup || session.serviceKind
        || ["completed", "cancelled", "failed", "deleted"].includes(session.status)) reason = "No active turn to steer";
    else if (session.pendingQuestion?.question || session.status === "input_required") reason = "Answer the question";
    else if (session.status === "waiting") reason = "No active turn to steer";
    else if (session.canWrite !== true) reason = "Write access is required";
    else if (attachments.length) reason = "Steering supports text only";
    else if (!steering?.state || steering.state.supported !== true || steering.state.reason === "unsupported"
        || steering.state.reason === "authz_not_enforced" || steering.state.reason === "disabled") reason = "Steering unavailable";
    else if (steering.state.recovering) reason = "Steering is recovering";
    else if (!steering.state.steerable || !steering.state.expectedTarget) reason = "No active turn to steer";
    else if (!draft.trim()) reason = "Enter guidance";
    else if (new TextEncoder().encode(draft.trim()).byteLength > (steering.state.limits?.maxBytes || 8192)) reason = "Guidance exceeds the text limit";
    return { enabled: !reason, reason, help: STEERING_HELP };
}

export function buildSteeringMessage(receipt) {
    const display = getSteeringDisplay(receipt);
    return {
        id: receipt.rowKey || `steering:${receipt.requestId}`,
        kind: "steering",
        role: "user",
        text: receipt.text ?? "Loading guidance...",
        createdAt: Date.parse(receipt.acceptedAt || receipt.createdAt) || 0,
        sender: receipt.actor ? { ...receipt.actor, kind: "user", display: receipt.actor.displayName } : null,
        steering: receipt,
        steeringLabel: display.label,
        steeringDetail: display.detail,
    };
}

export function appendSteeringEvent(chat, event) {
    const data = event?.data;
    const receipt = event.eventType === "session.steering_accepted" ? data?.receipt
        : event.eventType === "session.steering_updated" ? data?.projection : null;
    const requestId = receipt?.requestId || data?.steering?.requestId;
    if (!requestId) return false;
    const index = chat.findIndex(item => item.kind === "steering" && item.steering.requestId === requestId);
    // Updates and delivery references establish evidence, not acceptance's
    // transcript position. Their receipt remains in the separate archive.
    if (index < 0 && event.eventType !== "session.steering_accepted") return true;
    const previous = index >= 0 ? chat[index].steering : null;
    if (!receipt && previous) return true;
    const entry = mergeSteeringReceipt(
        { ...emptySteeringSession(), receipts: previous ? { [requestId]: previous } : {} },
        receipt || {
            requestId, sessionId: event.sessionId, revision: data.steering.revision,
            createdAt: event.createdAt,
        },
    );
    const merged = entry.receipts[requestId];
    if (merged) {
        const message = buildSteeringMessage(merged);
        if (index >= 0) chat[index] = message;
        else chat.push(message);
    }
    return true;
}
