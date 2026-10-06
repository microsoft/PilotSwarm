/**
 * Explicit guidance for an existing session, using a public management client.
 * The UI/caller owns and preserves options across ambiguous network failures.
 * Ordinary sends in sdk-app.js are intentionally unchanged.
 */
export async function submitGuidance(management, sessionId, options) {
    const result = await management.steerSessionTurn(sessionId, {
        text: options.text,
        clientRequestId: options.clientRequestId,
        expectedTarget: options.expectedTarget,
    });
    return result.ok
        ? { ...result, inspect: () => management.getSteeringRequest(sessionId, result.receipt.requestId) }
        : result;
}
