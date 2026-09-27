// pilotswarm-relay-core: everything that is the same for every relay service.
// Relay services plug in through RelayTransport and RelayProvider.
export * from "./transport.js";
export * from "./protocol.js";
export type { GrantedTransport, RelayProvider, RelayProvisioner } from "./provider.js";
export { KeySigner, fingerprintOf, fingerprintOfPem, generateKeyPair, publicKeyFromPem, type KeyPairPems } from "./keys.js";
export { ClusterSigner, HostSigner, TrustedClusters, checkHostProof, clusterStatement, hostStatement, newChallenge } from "./auth.js";
export {
    FileHostRegistry,
    MemoryHostRegistry,
    hashSecret,
    type ActivationResult,
    type HostRecord,
    type HostRegistry,
    type HostStatus,
} from "./host-registry.js";
export { HostStateStore, issueProfile, parseProfile, DEFAULT_ACTIVATION_MINUTES, type HostState, type RelayProfile } from "./profile.js";
export { OwnerAllowList, ANY_OWNER } from "./owner-allowlist.js";
export { RelayExecClient, RelayAccessError, type ExecCall, type ExecClientOptions } from "./exec-client.js";
export { serveConnection, describeThisHost, type HostOptions, type ServedConnection } from "./exec-host.js";
export { runCommand, type RunOptions, type RunOutcome, type RunningCommand } from "./run-command.js";
export { runRelayHost } from "./host-cli.js";
export { LoopbackTransport } from "./loopback.js";
