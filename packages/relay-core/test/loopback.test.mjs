// The shared relay checks over the in-memory provider. No network.

import { LoopbackTransport } from "../dist/index.js";
import { relayContract } from "./contract.mjs";

const transport = new LoopbackTransport("loopback/contract");

relayContract("loopback", {
    hostTransport: () => transport,
    callerTransport: () => transport,
});
