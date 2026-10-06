import React from "react";

export function SteeringReceipt({ message, controller }) {
    const receipt = message.steering;
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState("");
    const sessionId = receipt.sessionId;
    const requestId = receipt.requestId || receipt.clientRequestId;
    const invoke = async (operation) => {
        setPending(true);
        setError("");
        try {
            await operation();
        } catch (failure) {
            setError(failure.message);
        } finally {
            setPending(false);
        }
    };
    const button = (label, action, title) => React.createElement("button", {
        type: "button", className: "ps-mini-button", disabled: pending,
        onClick: () => invoke(action), title,
    }, label);
    return React.createElement("article", {
        className: "ps-steering-receipt",
        "data-steering-request-id": requestId,
        "aria-label": "Guidance receipt",
    },
    React.createElement("header", null,
        React.createElement("span", null, `${receipt.actor?.displayName || "You"} · Guidance`),
        React.createElement("span", { role: "status", "aria-live": "polite" }, ` — ${message.steeringLabel}`)),
    React.createElement("div", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, message.text),
    React.createElement("details", null,
        React.createElement("summary", null, "Delivery details"),
        React.createElement("p", null, message.steeringDetail),
        ...(receipt.attempts?.items || []).map((attempt, index) => React.createElement("p", {
            key: attempt.attemptId,
        }, `Attempt ${index + 1}: ${attempt.deliveredAt ? `Delivered (${attempt.deliveryKind})` : attempt.acknowledgedAt ? "Waiting for a safe point" : "Delivery unconfirmed"}`)),
        receipt.attempts?.nextCursor ? React.createElement("p", null, "Additional attempt evidence is available through the receipt API.") : null),
    controller ? React.createElement("div", { className: "ps-steering-actions" },
        receipt.actions?.canWithdraw ? button("Withdraw", () => controller.withdrawSteering(sessionId, receipt.requestId)) : null,
        receipt.actions?.canSendAsNewMessage ? button("Send as new message",
            () => controller.resendSteering(sessionId, receipt.requestId),
            "Adds this text to the message queue; earlier messages stay ahead.") : null,
        receipt.error && !receipt.rejected && !receipt.inFlight ? button("Reconcile acceptance",
            () => controller.retrySteering(sessionId, receipt.clientRequestId)) : null,
        button("Copy to draft", () => controller.copySteeringToDraft(sessionId, requestId)),
        button("Append to draft", () => controller.copySteeringToDraft(sessionId, requestId, { append: true })),
    ) : null,
    error ? React.createElement("p", { role: "alert" }, error) : null);
}
