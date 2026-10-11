export const approve = {
    allowedTargets: ["write", "stopped"],
    handler: context => ({
        kind: "advance",
        target: context.stateOutcome === "continue" ? "write" : "stopped",
    }),
};

export const write = {
    allowedTargets: ["observe"],
    handler: () => ({
        kind: "advance",
        target: "observe",
    }),
};

export const observe = {
    allowedTargets: ["done"],
    handler: () => ({
        kind: "advance",
        target: "done",
    }),
};
