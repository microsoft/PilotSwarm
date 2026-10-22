import { mock } from "node:test";
import * as sdk from "pilotswarm-sdk";

const { mode, agentPackages, failStart } = JSON.parse(process.argv[2]);
if (agentPackages) Object.freeze(agentPackages);
const fixtureError = new Error("fixture worker start failure");
const workers = [];
const started = [];
const stopped = [];

mock.module("pilotswarm-sdk", {
    namedExports: {
        ...sdk,
        PilotSwarmWorker: class {
            constructor(options) {
                this.workerNodeId = options.workerNodeId;
                this.loadedAgents = [];
                this.allowedAgentNames = [];
                workers.push({
                    workerNodeId: options.workerNodeId,
                    store: options.store,
                    pluginDirs: options.pluginDirs,
                    hasAgentPackages: Object.hasOwn(options, "agentPackages"),
                    samePackageOptions: options.agentPackages === agentPackages,
                    agentPackages: options.agentPackages,
                });
            }
            async start() {
                if (failStart) throw fixtureError;
                started.push(this.workerNodeId);
            }
            async stop() {
                stopped.push(this.workerNodeId);
            }
        },
        PilotSwarmClient: class {
            async start() { started.push("client"); }
            async stop() { stopped.push("client"); }
        },
        PilotSwarmManagementClient: class {
            async start() { started.push("management"); }
            async stop() { stopped.push("management"); }
        },
    },
});

const { NodeSdkTransport } = await import("pilotswarm/host");
const transport = new NodeSdkTransport({
    store: "sqlite::memory:",
    mode,
    ...(agentPackages !== undefined ? { agentPackages } : {}),
});
let error;
try {
    await transport.start();
} catch (startupError) {
    error = startupError;
} finally {
    await transport.stop();
}
process.stdout.write(JSON.stringify({
    workers,
    started,
    stopped,
    error: error?.message ?? null,
    sameError: error === fixtureError,
}));
