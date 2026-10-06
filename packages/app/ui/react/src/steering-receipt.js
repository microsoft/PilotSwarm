import React from "react";
import { getSteeringAttemptDisplay } from "pilotswarm/ui-core";

export function SteeringReceipt({ message, controller }) {
    const receipt = message.steering;
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState("");
    const sessionId = receipt.sessionId;
    const requestId = receipt.requestId || receipt.clientRequestId;
    const resend = message.steeringResend;
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
    const button = (label, action, title, disabled = false) => React.createElement("button", {
        type: "button", className: "ps-mini-button", disabled: pending || disabled,
        "aria-label": label === "Withdraw" ? "Withdraw guidance" : label,
        onClick: () => invoke(action), title,
    }, label);
    return React.createElement("article", {
        className: "ps-steering-receipt",
        "data-testid": "steering-request",
        "data-request-id": requestId,
        "data-session-id": sessionId,
        "data-steering-request-id": requestId,
        "aria-label": "Guidance receipt",
    },
    React.createElement("header", null,
        React.createElement("span", null, `${receipt.actor?.displayName || receipt.actor?.subject || (receipt.requestId ? "User" : "You")} · Guidance`),
        React.createElement("span", { role: "status", "aria-live": "polite", "data-testid": "steering-status" }, ` — ${message.steeringLabel}`)),
    React.createElement("div", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, message.text),
    React.createElement("details", null,
        React.createElement("summary", null, "Delivery details"),
        React.createElement("p", null, message.steeringDetail),
        resend?.phase === "uncertain" ? React.createElement("p", { role: "alert" },
            "New-message enqueue unconfirmed. Retrying reuses its identity but may repeat ordinary input.") : null,
        resend?.phase === "queued" ? React.createElement("p", null,
            "Added as an ordinary queued message; this original guidance receipt is unchanged.") : null,
        resend?.error ? React.createElement("p", { role: "alert" }, resend.error) : null,
        ...(receipt.attempts?.items || []).map((attempt, index) => React.createElement("p", {
            key: attempt.attemptId,
        }, `Attempt ${attempt.attemptNo || index + 1}: ${getSteeringAttemptDisplay(attempt)}`)),
        receipt.attempts?.nextCursor ? React.createElement("p", null, "Additional attempt evidence is available through the receipt API.") : null),
    controller ? React.createElement("div", { className: "ps-steering-actions" },
        receipt.actions?.canWithdraw ? button("Withdraw", () => controller.withdrawSteering(sessionId, receipt.requestId)) : null,
        receipt.actions?.canSendAsNewMessage ? button("Send as new message",
            () => controller.resendSteering(sessionId, receipt.requestId),
            resend?.phase === "uncertain"
                ? "Retry the same ordinary message identity. The earlier enqueue may have succeeded."
                : "Adds this text to the message queue; earlier messages stay ahead.",
            resend?.phase === "sending") : null,
        receipt.error && !receipt.rejected && !receipt.inFlight ? button("Reconcile acceptance",
            () => controller.retrySteering(sessionId, receipt.clientRequestId)) : null,
        button("Copy to draft", () => controller.copySteeringToDraft(sessionId, requestId), undefined, typeof receipt.text !== "string"),
        button("Append to draft", () => controller.copySteeringToDraft(sessionId, requestId, { append: true }), undefined, typeof receipt.text !== "string"),
    ) : null,
    error ? React.createElement("p", { role: "alert" }, error) : null);
}
