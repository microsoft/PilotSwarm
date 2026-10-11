export function targetForOutcome(outcome, succeeded, otherwise) {
    return outcome === "succeeded" ? succeeded : otherwise;
}
