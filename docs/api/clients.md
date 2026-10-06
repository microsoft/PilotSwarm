# Choosing a Client

Every way of talking to a deployment rides the same Web API
(see [Layering](../architecture/layering.md)). Pick the layer that matches
your app's shape:

| You are building… | Use | Package / doc |
|---|---|---|
| A service or script that **drives sessions to completion** (send, wait for the answer, resume) | `PilotSwarmClient({ apiUrl })` + `PilotSwarmManagementClient({ apiUrl })` | [`pilotswarm-sdk`](../developer/building/sdk-apps.md) |
| Something that **reads/writes facts or the knowledge graph** | `createWebFactStore(api)` / `createWebGraphStore(api)` — the SDK's `FactStore`/`GraphStore` interfaces over HTTP | [Facts & Graph](../developer/building/facts-and-graph.md) |
| Your **own UI** (state-driven: session lists, live event streams) | `HttpApiTransport`, or raw `ApiClient` | [Building a Custom UX](./building-a-custom-ux.md), [`pilotswarm-sdk/api`](../../packages/sdk/api/README.md) |
| An **LLM/agent integration** (Claude Desktop, Cursor, custom MCP client) | the MCP server, `pilotswarm-mcp --api-url` | [`pilotswarm`](../../packages/app/mcp/README.md) |
| A **non-JS client** (curl, another language) | raw HTTP against `/api/v1` | [Web API Reference](./reference.md) |

## Rules of thumb

- **App-shaped work wants the SDK clients.** `sendAndWait`, resume semantics,
  turn completion, typed management calls — don't re-implement these over raw
  HTTP.
- **UI-shaped work wants the transport.** A UI tracks many sessions in its own
  store and reduces raw events; stateful session handles would fight it. The
  shipped portal and TUI both sit on `HttpApiTransport` for exactly this
  reason.
- **Never bypass the seam.** `{ store }` constructors and `--store` flags are
  internal (portal server, workers, tests). If you're holding a database URL
  in a user-facing process, you're on the wrong layer.
- **The operations table is the contract.** All of these clients are thin over
  `packages/sdk/api/src/protocol.js`; the reference doc is generated from
  it, and the portal server's routes are too.

## Steering a running turn

Use the management client in both modes. A public client supplies `{ apiUrl }`;
a trusted in-process component may supply `{ store }` and authenticated actor
context. Never construct a store in a UI, CLI, or MCP handler.

```js
const management = new PilotSwarmManagementClient({ apiUrl, getAccessToken });
await management.start();
const state = await management.getSessionSteeringState(sessionId);
if (!state.steerable || !state.expectedTarget) {
    throw new Error(`Steering unavailable: ${state.reason}`);
}
// Persist these options before the network call if your client must recover.
const options = {
    text: "Preserve the public API while making the change.",
    clientRequestId: crypto.randomUUID(),
    expectedTarget: state.expectedTarget,
};
const result = await management.steerSessionTurn(sessionId, options);
if (!result.ok) throw new Error(`Guidance refused: ${result.code}`);
const current = await management.getSteeringRequest(sessionId, result.receipt.requestId);
console.log(current.disposition);
await management.stop();
```

`PilotSwarmClient.steerSessionTurn(sessionId, options)` and
`PilotSwarmSession.steer(text, { clientRequestId, expectedTarget })` use the same
acceptance implementation. They do not fetch a replacement target or generate
a hidden retry identity. Preserve the exact options on an ambiguous retry.
Acceptance does not wait for delivery, and delivery does not prove compliance.

For a trusted in-process direct client, supply validated actor/policy context,
not request-body authority:

```js
const management = new PilotSwarmManagementClient({
    store,
    steeringContext: {
        sender: { kind: "user", provider: principal.provider, subject: principal.subject },
        isAdmin: authorizedRole === "admin",
        adminScope,
        authzEnforced: true,
    },
});
```

The same context can be passed as the trailing direct-method argument.
Without a validated actor, direct steering fails closed. Web clients ignore
this context argument; the server derives authority from authentication.

Read/list/withdraw/stats have direct and web management equivalents. The
[reference](./reference.md#session-steering) defines typed outcomes, cursor
scope, and the separate inclusion and no-resend evidence.

## Workers are the exception

`PilotSwarmWorker` always connects directly to the datastore (`{ store }`).
It is the trusted backend that executes turns — it is not a client of the
deployment, it is part of it.
