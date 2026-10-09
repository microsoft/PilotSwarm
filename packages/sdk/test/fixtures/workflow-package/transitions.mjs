import { targetForOutcome } from "./transition-helper.mjs";

export const inspect = {
    allowedTargets: ["publish", "needs-attention"],
    handler: context => ({
        kind: "advance",
        target: targetForOutcome(
            context.stateOutcome,
            "publish",
            "needs-attention",
        ),
    }),
};

export const publish = {
    allowedTargets: ["committed", "failed"],
    handler: context => ({
        kind: "advance",
        target: targetForOutcome(context.stateOutcome, "committed", "failed"),
    }),
};
