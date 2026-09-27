#!/usr/bin/env node
// pilotswarm-relay for Azure Relay: the core host CLI with this provider plugged in.
import { runRelayHost } from "pilotswarm-relay-core";
import { azureRelayProvider } from "./provider.js";

runRelayHost(azureRelayProvider, process.argv.slice(2)).catch((error: Error) => {
    process.stderr.write(`pilotswarm-relay: ${error.stack ?? error.message}\n`);
    process.exit(1);
});
