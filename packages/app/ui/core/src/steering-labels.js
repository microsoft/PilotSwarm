import { getSteeringDisplay } from "./steering.js";

/** Human wording beside, never instead of, canonical machine fields. */
export function steeringResultDisplay(result) {
    if (result?.receipt) return getSteeringDisplay(result.receipt);
    if (result?.requestId) return getSteeringDisplay(result);
    if (Array.isArray(result?.items)) return {
        label: `${result.items.length} guidance receipts${result.nextCursor ? " (partial list)" : ""}`,
        detail: result.items.map(item => `${item.requestId}: ${getSteeringDisplay(item).label}`).join("\n"),
    };
    if (result?.ok === false) return { label: "Guidance refused", detail: `${result.code}${result.reason ? `: ${result.reason}` : ""}` };
    if (typeof result?.steerable === "boolean") return {
        label: result.steerable ? "Ready to steer the current turn" : "Steering unavailable",
        detail: result.unsupportedReason || result.reason || "",
    };
    return { label: result?.outcome === "forbidden" ? "Guidance refused" : "Guidance status", detail: result?.outcome || "" };
}
