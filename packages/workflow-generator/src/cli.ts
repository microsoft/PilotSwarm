#!/usr/bin/env node

import { runWorkflowGenerator } from "./index.js";

runWorkflowGenerator().catch((error) => {
    console.error("[workflow-generator] fatal", error);
    process.exitCode = 1;
});
