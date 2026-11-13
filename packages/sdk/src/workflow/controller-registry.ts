import { workflowController_1_0_0 } from "./controller_1_0_0/index.js";
import { workflowController_1_1_0 } from "./controller/index.js";
import { WORKFLOW_CONTROLLER_VERSION } from "./controller-version.js";

/** Frozen versions first, live last. Dispatch always uses the version stored on the run. */
export const WORKFLOW_CONTROLLER_REGISTRY = [
    { version: "1.0.0", handler: workflowController_1_0_0 },
    { version: WORKFLOW_CONTROLLER_VERSION, handler: workflowController_1_1_0 },
] as const;
