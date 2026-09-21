import {
    dehydrateGitWorkspace,
    hydrateGitWorkspace,
} from "../dist/index.js";

/**
 * Compose one repository enlistment with PilotSwarm's turn lifecycle.
 *
 * The caller owns repository placement, credentials, and the durable adapters.
 * `blobs` can use any binary object store and `state` can use any transactional
 * database, provided the state row is written only after all artifacts.
 */
export function createRepositoryWorkspaceHooks({
    resolveEnlistment,
    blobsFor,
    stateFor,
    targetRefFor,
    detachedCheckout = false,
}) {
    return {
        beforeTurn: (context) => hydrateGitWorkspace({
            enlistmentDir: resolveEnlistment(context),
            blobs: blobsFor(context.sessionId),
            state: stateFor(context.sessionId),
            targetRef: targetRefFor?.(context),
            detachedCheckout,
            trace: context.trace,
        }),
        afterTurn: (context) => dehydrateGitWorkspace({
            enlistmentDir: resolveEnlistment(context),
            blobs: blobsFor(context.sessionId),
            state: stateFor(context.sessionId),
            trace: context.trace,
        }),
    };
}

// Example:
//
// const hooks = createRepositoryWorkspaceHooks({
//     resolveEnlistment: ({ sessionId }) => workspaces.resolve(sessionId).path,
//     blobsFor: (sessionId) => ({
//         get: (kind) => objectStore.get(`${sessionId}/git/${kind}`),
//         put: (kind, data) => objectStore.put(`${sessionId}/git/${kind}`, data),
//     }),
//     stateFor: (sessionId) => ({
//         get: () => database.getRepositoryState(sessionId),
//         set: (next) => database.setRepositoryState(sessionId, next),
//     }),
//     targetRefFor: () => "origin/main",
// });
//
// const worker = new PilotSwarmWorker({ store, ...hooks });
