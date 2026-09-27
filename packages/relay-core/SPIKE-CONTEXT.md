# Outbound relay spike (issue #27)

Spike notes, written 2026-09-27 at the end of the spike. They record what was
built, what we learned from live tests, and what to do next.

**What this is:** a working spike for GitHub issue
[microsoft/PilotSwarm#27](https://github.com/microsoft/PilotSwarm/issues/27),
"Outbound relay execution for private sessions". It runs commands on a machine
outside Kubernetes (the **host**) for a PilotSwarm session. The host only dials
out, through a relay service. It needs no inbound firewall rule.

**Status:** built and working end to end against real Azure Relay. Nothing is
wired into PilotSwarm itself yet: a small "portal" script and the Copilot SDK
demo play the PilotSwarm side.

---

## 1. Words used in this file

| Word | Meaning |
|---|---|
| **host** | The machine that runs commands. It runs `pilotswarm-relay`. |
| **cluster** | The PilotSwarm deployment that sends commands. In the spike, `demo.ts` plays it. |
| **portal** | The PilotSwarm web portal. In the spike, `portal-standin.ts` plays it. |
| **relay service** | The public service both sides dial out to. Today: Azure Relay Hybrid Connections. |
| **provider** | The code for one relay service (`packages/relay-azure`). |
| **core** | Everything that is the same for every relay service (`packages/relay-core`). |
| **endpoint** | One named rendezvous point on the relay service. For Azure: one hybrid connection. Each host gets its own. |
| **grant** | The provider's credential for one endpoint. For Azure: the endpoint name plus a SAS token. The core carries it but never reads it. |
| **SAS token** | Azure's shared-access token: an HMAC signature over a resource URI and an expiry, made with a key. |
| **profile** | The one file a host needs. The portal makes it. See section 5. |
| **activation** | The first connection after a profile is issued. The host proves it holds the profile's one-time secret, and the cluster pins the host's key. |
| **pinned host key** | The host's public key, saved by the cluster at activation. Every later connection must prove this key. |

---

## 2. Where everything lives

### Code

| What | Where |
|---|---|
| Branch | `relay-transport-spike`, made from `main` at `7b27b349` |
| Core package | `packages/relay-core/` (this folder) |
| Azure provider | `packages/relay-azure/` |

Things that will trip you up:

- **The packages are git-ignored.** `.gitignore:230` has `**/[Pp]ackages/*`, a
  leftover Visual Studio rule. `git status` does not show these folders. Commit
  them with `git add -f packages/relay-core packages/relay-azure`.
- **`node_modules` was borrowed.** The spike ran in a git worktree whose root
  `node_modules` was a symlink to the main checkout's `node_modules`. Nothing was
  installed and the lockfile was not changed. In a normal checkout, run `npm ci`
  at the root first.
- **Core is linked by a symlink too.**
  `packages/relay-azure/node_modules/pilotswarm-relay-core → ../../relay-core`.
  It stands in for npm workspace linking.
- **Build order:** core first, then azure. Each has `npm run build` (`tsc`).
  From inside a package: `node ../../node_modules/typescript/bin/tsc -p .`

### Keys and local state (never in the repo)

`~/.config/pilotswarm-relay/` (folder mode 700, files mode 600):

| Path | What |
|---|---|
| `spike.env` | Every relay setting and key. Loaded with `node --env-file=...`. |
| `cluster/cluster.key`, `cluster.pub` | The cluster's P-256 key pair. |
| `cluster/hosts.json` | The host registry: every host, its status, its pinned key. Stands in for a database table. |
| `host/<hostId>/state.json`, `host.key` | One host's saved state and private key (made on the host). |
| `old-ed25519/` | The retired Ed25519 cluster keys from before the P-256 switch. |

This folder is kept outside the repo on purpose, so no key can be committed.

`spike.env` holds these settings (key values are secrets and are not shown):

```
RELAY_NAMESPACE              <namespace>.servicebus.windows.net
RELAY_PATH                   relay-spike          (the fixed hybrid connection the tests use)
RELAY_LISTEN_KEY_NAME/_KEY   host-listen          (hybrid-connection rule, Listen; tests only)
RELAY_SEND_KEY_NAME/_KEY     caller-send          (hybrid-connection rule, Send; tests only)
RELAY_SUBSCRIPTION           <subscription id>
RELAY_RESOURCE_GROUP         <resource group>
RELAY_MINT_LISTEN_KEY_NAME/_KEY  portal-mint-listen   (namespace rule, Listen; the portal signs host tokens)
RELAY_CLUSTER_SEND_KEY_NAME/_KEY cluster-send         (namespace rule, Send; the cluster connects to hosts)
RELAY_CLUSTER_DIR            ~/.config/pilotswarm-relay/cluster
PORTAL_URL                   https://pilotswarm.example.test   (display only)
```

To read a key value: `az relay namespace authorization-rule keys list -g <resource group> --namespace-name <namespace> -n <rule> --subscription <subscription id>`
(for `host-listen` / `caller-send` use `az relay hyco authorization-rule keys list ... --hybrid-connection-name relay-spike`).

### Azure

What the spike needs in an Azure subscription:

| What | Value |
|---|---|
| Resource provider | `Microsoft.Relay`, registered in the subscription |
| Namespace | One Azure Relay namespace, Standard tier |
| Hybrid connections | `relay-spike` (tests). Per-host `s-<uuid>` ones are created and deleted by the portal stand-in. |
| Rules on `relay-spike` | `host-listen` (Listen), `caller-send` (Send) |
| Rules on the namespace | `portal-mint-listen` (Listen), `cluster-send` (Send). Azure's default `RootManageSharedAccessKey` is not used. |

Cost is small: Azure Relay bills per connected listener hour, and nothing listens when no host runs.

### Other pointers

- The issue: https://github.com/microsoft/PilotSwarm/issues/27.
  One comment on it: ngrok works on any cloud, but Azure Relay is the most mature.

---

## 3. How to run it

All commands run from the package folder named.

```
# build
cd packages/relay-core  && npm run build
cd packages/relay-azure && npm run build

# offline tests (core): 47 checks, in-memory relay, ~5 s
cd packages/relay-core && npm test

# live tests (azure): 38 checks against real Azure Relay, ~1-2 min
cd packages/relay-azure && npm run test:live
#   RELAY_CONTRACT_DEBUG=1 prints every message both sides send and receive

# the full demo
cd packages/relay-azure
npm run portal -- add-host --owner alice@example.com --out ~/Downloads/laptop.relay.json
npm run relay  -- --profile ~/Downloads/laptop.relay.json          # the host: no env needed at all
npm run demo   -- --owner alice@example.com "what OS is the host on?"
npm run portal -- list-hosts
npm run portal -- revoke-host <hostId>                             # host drops in ~20 s, then exits

# a new cluster key (refuses to overwrite)
cd packages/relay-core && npm run keygen -- ~/.config/pilotswarm-relay/cluster
```

- The first `demo` run within 10 minutes of `add-host` activates the host.
  After 10 minutes the profile can no longer be activated; add the host again.
- `demo` needs `GITHUB_TOKEN`, from the environment or the repo root `.env`.
- `relay --allow <email>` is optional. It refuses to start unless the profile was issued to that person.
- The host keeps state per profile in `~/.config/pilotswarm-relay/host/<hostId>/`.
  Use `--state-dir` to act as a different machine (the stolen-profile test did this).

---

## 4. The code

### The split between core and provider

```
packages/relay-core   (zero npm dependencies; imports only its own files and node: built-ins)
   RelayTransport    frames both ways; one per endpoint                      transport.ts
   GrantedTransport  a host transport whose grant can be replaced            provider.ts
   RelayProvisioner  portal side: create endpoint, renew grant, delete       provider.ts
   RelayProvider     what a relay service plugs in (the three above)         provider.ts
        ▲
        │ implements
packages/relay-azure
   AzureRelayTransport, AzureRelayProvisioner, azureRelayProvider
```

A new relay service needs: a transport, a provisioner, a `RelayProvider`, a
two-line bin that calls `runRelayHost(provider, argv)`, and a test file that
runs `relayContract()` from `pilotswarm-relay-core/testing/contract`.

### File map: `packages/relay-core/src`

| File | Lines | What it does |
|---|---|---|
| `transport.ts` | 126 | `RelayTransport` / `RelayConnection` / `RelayListener` contract, typed `RelayTransportError` kinds (`unauthorized`, `not_found`, `no_listener`, `network`, `closed`, `protocol`), `BaseRelayConnection` (holds early frames, fires close once) |
| `provider.ts` | 37 | `RelayProvider`, `RelayProvisioner`, `GrantedTransport` |
| `protocol.ts` | 209 | Message types (v4), encode/decode, `checkExecRequest` |
| `keys.ts` | 84 | EC P-256 keys, fingerprints (`sha256:` + base64url of SPKI DER), sign/verify with 64-byte r‖s signatures |
| `auth.ts` | 102 | The signed statements, `ClusterSigner`, `HostSigner`, `TrustedClusters`, `checkHostProof` |
| `profile.ts` | 153 | `issueProfile`, `parseProfile`, `HostStateStore` (host-side state + host key) |
| `host-registry.ts` | 150 | `HostRegistry` interface; `MemoryHostRegistry`, `FileHostRegistry`; activation rules |
| `owner-allowlist.ts` | 71 | Emails / Entra object ids a host serves; only `provider: "entra"` owners match |
| `exec-host.ts` | 233 | Host end: handshake, activation, grant updates, owner check, runs commands |
| `exec-client.ts` | 291 | Cluster end: handshake, host check, activation, grant push, owner pre-check, exec |
| `run-command.ts` | 167 | Runs `command: string[]` in its own process group; timeout; kills the whole tree; 64 KiB inline cap per stream with full byte count + SHA-256 |
| `host-cli.ts` | 236 | `runRelayHost(provider, argv)`: `--profile`, consent screen, reconnect loop, exits on `not_found` / `unauthorized` |
| `cluster-keygen.ts` | 30 | `pilotswarm-relay-cluster-keygen <dir>` |
| `loopback.ts` | 105 | In-memory provider for tests |
| `fs-util.ts` | 10 | Atomic file write (temp + rename, mode 600) |

Tests (`packages/relay-core/test`): `contract.mjs` (the shared checks every
provider runs), `loopback.test.mjs`, `keys-auth.test.mjs`,
`profile-registry.test.mjs`, `allowlist.test.mjs`.

### File map: `packages/relay-azure/src`

| File | Lines | What it does |
|---|---|---|
| `azure-relay.ts` | 390 | Hybrid Connections protocol on the `ws` package: listen (control socket + accept), connect, SAS tokens, keepalive, token renew. Two modes: sign own tokens (key) or use a ready-made token (host). `refreshGrant` swaps the token live. |
| `provisioner.ts` | 100 | ARM `PUT`/`DELETE` of hybrid connection `s-<uuid>`; 7-day Listen tokens signed with the namespace mint key and limited to one hybrid connection |
| `provider.ts` | 67 | `azureRelayProvider`; `transportsFromEnv` (test helper) |
| `cli.ts` | 9 | The `pilotswarm-relay` bin |
| `portal-standin.ts` | 96 | `add-host` / `list-hosts` / `revoke-host` |
| `demo.ts` | 263 | Copilot SDK session, only tool `relay_exec`, plays the cluster |
| `ws.d.ts` | 39 | Local types for `ws` (`@types/ws` is not installed) |

Test: `test/azure-live.test.mjs` (the shared checks, Azure key/rights checks,
and one full provisioning run).

---

## 5. How it works

### The message flow (protocol v4, one JSON message per frame)

```
host    → cluster  hello         challenge H. Nothing else is revealed yet.
cluster → host     auth          cluster signature over (cluster fp, endpoint, H) + challenge C
host    → cluster  auth_failed   (then close) if the cluster is not trusted
host    → cluster  ready         host signature over (host fp, cluster fp, endpoint, C), host public key,
                                 host summary, allow list; the activation secret only on first contact
cluster → host     host_ok       cluster accepted the host (activated: true on first contact)
cluster → host     host_refused  (then close) if the host key is wrong
cluster → host     grant_update  a fresh relay credential for the host
cluster → host     exec          only after host_ok
host    → cluster  exec_result   one per exec, matched by id
```

Signed text formats (change the version line if they ever change):

```
pilotswarm-relay/cluster-auth/v2\ncluster=<fp>\nendpoint=<endpointId>\nchallenge=<H>\n
pilotswarm-relay/host-auth/v2\nhost=<fp>\ncluster=<fp>\nendpoint=<endpointId>\nchallenge=<C>\n
```

- The challenges are fresh per connection, so an old signature cannot be replayed.
- The endpoint name is signed, so a signature made for one host cannot be used on another.
- The host sends the activation secret only **after** the cluster proves who it is.
- For Azure, `endpointId` = `<namespace>/<hybrid connection>`, lower case.

### Adding a host (the profile flow)

```
Portal (a signed-in user clicks "add a host"):
1. Creates hybrid connection s-<uuid> for this host only
2. Signs a 7-day Listen token limited to that hybrid connection
3. Makes a one-time activation secret (10 minutes); the registry keeps only its SHA-256
4. Writes the profile: { hostId, portal, issuedTo, cluster public keys,
                         relay: { provider, endpointId, grant }, activation: { secret, expiresAt } }

Host:
5. pilotswarm-relay --profile <file>   (needs nothing else, not even env settings)
6. Consent screen: issued to, cluster fingerprint, endpoint, machine, user. Compare the fingerprint with the portal.
7. Makes its own P-256 host key (it never leaves the machine), starts listening

Cluster, first connection:
8. Both key checks. The host sends the secret; the cluster checks the signature FIRST,
   then the secret (so a bad proof never spends it), then pins the host key.
9. host_ok { activated: true } → the host deletes the secret from its state
10. grant_update → a fresh 7-day token; the host saves it and renews on the live socket

Later connections: key checks both ways, then a fresh token, then commands.
Revoke: registry marks the host revoked + deletes its hybrid connection → the host drops
(16-20 s), cannot re-register (not_found), prints why, and exits.
```

### Whose sessions a host serves

- The host serves only the profile's owner (`issuedTo`): their email, and their Entra object id when known.
- The list reaches the cluster in `ready`. The cluster checks each session's owner
  **before** sending a command. The host checks again. Both layers are tested.
- Owners with any provider other than `entra` never match.

### Running a command

- `command: string[]`. No shell unless the command names one (`["sh", "-c", "..."]`).
- Each command runs in a new process group. Timeout, a dropped connection, or relay
  shutdown kills the whole tree (SIGTERM, SIGKILL after 2 s; SIGKILL at once on shutdown).
- Stdout and stderr stay separate. Each: 64 KiB inline, plus the full byte count and SHA-256.
- Nothing ever runs locally on the cluster side. A dropped connection fails the call
  as "outcome unknown".

---

## 6. Decisions and why

In the order we made them:

1. **Azure Relay first, behind a provider contract.** It is the mature first-party
   choice. The contract keeps a second provider possible (a self-hosted WebSocket
   relay is the likely second; ngrok and Cloudflare Tunnel work similarly).
2. **SAS keys, not Entra, for now.** Faster, and the host needs no Azure identity.
   Entra can be added later (section 9).
3. **The host states whose sessions it serves (`--allow`), and PilotSwarm validates
   that list before sending.** The host re-checks: it is the machine at risk.
4. **Only the designated cluster can connect.** The host pins the cluster's public key.
5. **Clean core/provider split.** Core has no dependencies. Azure types never leave the provider.
6. **The host knows only a profile file.** No portal URL, no relay keys, no env.
   The portal can stay private in a VNet. The cluster only dials out and never listens.
7. **P-256, not Ed25519.** Azure Key Vault can hold P-256 keys and sign with them
   without ever exporting them. It does not support Ed25519. Signatures use the
   64-byte r‖s form, which is also what Key Vault returns.
8. **One hybrid connection per host, all names the same length.** See finding 2.
9. **The cluster pushes renewed tokens** over the authenticated connection, so the
   host never needs to reach the portal again.

---

## 7. What we learned

### Azure Relay

1. **The 404 reason is in the HTTP status line, not the body.** Azure uses 404 for
   both "There are no listeners connected" and "Endpoint does not exist".
2. **A SAS token's resource URI is a string prefix.** A token for `session-a` also
   opened `session-ab` (tested live). Every per-host name is `s-` + a UUID, so no
   name can be the start of another.
3. **Deleting a hybrid connection drops a connected host after 16-20 s**, with
   close code 1011 "NameRenewalFailed" (the docs say 1001). Measured four times
   (19.5, 17.4, 17.4, 16 s).
4. **One namespace-wide key can sign tokens limited to one hybrid connection.** So
   the deployment needs just one Listen key and one Send key.
5. **The sender (the cluster) only ever talks to the namespace hostname.** Only the
   listener (the host) dials Azure's changing gateway names
   (names like `g<n>-prod-<region>-<id>-sb.servicebus.windows.net`). So:
   the cluster's firewall rule can be one exact name; hosts need `*.servicebus.windows.net`.
6. **A namespace can have a private endpoint and public access at the same time**
   (docs). So the cluster can reach it privately from a VNet while hosts come in publicly.
   The docs' "open ports 9400-9599" note applies only to listeners on a private endpoint.
7. **Azure sometimes kills a relayed connection silently.** Neither side gets a
   close; both sides' pings stop being answered, so our keepalive notices only
   after 45-90 s. See the open flake in section 8.
8. **Throughput** laptop → Azure → laptop: about 1.5 MiB/s with 256 KiB+ frames,
   0.8 MiB/s with 16 KiB frames. A floor, not Azure's limit: both ends were on
   the same home connection.
9. **Up to 25 listeners can share one hybrid connection**, and Azure spreads callers
   across them. That is why a stolen profile matters (finding 11).
10. Keepalive: one missed pong on an otherwise healthy link dropped a registration
    once. The code now tolerates one miss (two in a row = dead).

### Security, from the live tests

11. **A stolen, already-activated profile cannot get commands or data**, but Azure
    gave the thief 5 of 6 connections. It can nearly knock the real host offline.
    Fix proposed in section 9, item 1.
12. **A leaked Send key alone is useless** since the cluster lock: tested live with a
    "stranger cluster" that held the real Send key.
13. **Azure Relay can read the traffic.** TLS ends at Azure on both legs.

### PilotSwarm (as of `origin/main` `7b27b349`)

14. **Session ownership** lives in `session_owners` (0..1 row per session) →
    `users(provider, subject)` (`packages/sdk/src/cms-migrations.ts:3761-3778`).
    For Entra, `provider = "entra"`, `subject = oid` (falls back to `sub`)
    (`packages/app/web/auth/normalize/entra.js:8-23`).
    Access checks use the **root** session's owner (`cms_get_session_access`, `cms-migrations.ts:8350-8395`).
15. **Sessions without a real Entra owner:** system sessions, direct/SDK-mode
    sessions, sub-agents under a system parent (`system/system`), no-auth Web API
    (`none/unknown`), dev auth (`dev/<persona>`).
16. **`AUTHZ_ENFORCE_OWNERSHIP` defaults to `false`.** Most owner checks only log
    "would deny". Relay access must be enforced regardless, like `session:share`.
17. **Roles trap:** if a token carries ANY `roles` claim, only `admin`/`user`
    count, and anything else means deny (`packages/app/web/auth/authz/engine.js:94-113`).
    Adding a `relay` app role would lock people out of the portal unless that code changes.
18. **The tenant id (`tid`) is not stored.** Fine: the app registration is single-tenant.
19. **The `pilotswarm` CLI signs in with MSAL**, discovering `clientId`/authority from
    `GET /api/v1/auth/config`, scope `<clientId>/.default`, cache
    `~/.config/pilotswarm/auth/<origin>.json` (`packages/app/tui/src/auth/entra-auth.js`).
20. **Sharing:** `session_shares` (read/write) + `sessions.visibility`
    (`private` / `shared_read` / `shared_write`). The one access predicate is
    `evaluateSessionAccess` (`packages/sdk/api/src/session-authz.js:73-126`).

### Copilot SDK 1.0.13 and MCP

21. `availableTools: ["relay_exec"]` turns off every built-in tool. That is how
    the demo proves nothing runs locally.
22. **MCP servers can only be a local command (stdio) or a URL (http/sse).** There is
    no in-process MCP option (`@github/copilot-sdk/dist/types.d.ts:1402-1452`).
23. PilotSwarm builds each session's `mcpServers` from plugin `.mcp.json` files,
    agent `mcpServers:` references, and `use_package` (`packages/sdk/src/session-manager.ts:1520-1530, 2089`).
    Changing that map changes the session's fingerprint, and PilotSwarm drops the
    warm Copilot session and resumes it (`session-manager.ts:2007-2017, 2111-2117`).
24. PilotSwarm auto-approves every MCP tool call (`packages/sdk/src/permissions.ts:73-80`).
25. Custom PilotSwarm tools need both a declaration (`systemToolDefs`) and a
    `runTurn` handler.

---

## 8. Tests and known problems

- **Core:** 47 checks pass (`npm test`).
- **Azure live:** 38 checks pass (`npm run test:live`), including one full run:
  create an endpoint → a host with only its profile → activate → push a token →
  check that the token opens only that endpoint → delete → the host drops.
- **The tests can fail:** each of these deliberate breaks was caught by the right test:
  - caller's owner check off
  - host's owner check off
  - provider check off
  - host accepts any cluster signature
  - endpoint dropped from the signature
  - commands before the handshake
  - pinned-key check off
  - secret spent before the signature check
  - spent secret reusable
  - grant update before the handshake
  - activation secret sent before the cluster proves itself
  - process group not killed
- **The full demo passed:** portal add-host → host in an empty env → activation →
  pinned reconnect → stolen profile refused → revoke → both hosts exit in 16 s.

**Open flake:** the shared checks fail on Azure in about 1 run in 4 (3 of about 12
runs, a different check each time, always one waiting on an `exec`). It is **not**
our protocol. The debug trace (`RELAY_CONTRACT_DEBUG=1`) showed:

```
caller sends exec on a connection that worked seconds earlier
→ the host never receives it
→ no close reaches either side
→ both sides find out only via keepalive, 45-90 s later (code 1006)
```

Our code fails the call as "outcome unknown", but slowly, and the tests time out at 60 s.

---

## 9. Next steps (ordered)

1. **Move the host to a new endpoint at activation.** It fixes finding 11.
   ```
   Over the connection that just passed both key checks:
   1. Cluster creates s-<new uuid> and pushes a grant for it
   2. Host re-registers there; cluster deletes the profile's endpoint
   → after activation the downloaded file is useless
   ```
   `refreshGrant` currently refuses a different endpoint; it needs a "move" path,
   and the registry needs to update `endpointId`.
2. **Fix the silent-connection problem.** Before reusing a connection idle for more
   than a few seconds, send an app-level `ping` message and wait about 2 s for `pong`.
   Otherwise open a new connection. Or use one connection per command (~1-2 s extra).
   Also look for Azure Relay guidance on idle rendezvous connections.
3. **"Approve this machine" in the portal.** After activation, hold off routing
   sessions until the owner confirms the machine and key fingerprint. This closes the
   10-minute race on a profile stolen before activation.
4. **Keep the cluster key in Key Vault** and sign through it. It is already P-256.
5. **Integrate into PilotSwarm for real:**
   - CMS tables for hosts (the `HostRecord` shape) and, if needed, invites
   - Web API operations: add host (returns the profile), list, revoke. Each new
     operation also goes in the hand-written `http-api-transport.js`; a parity test checks it.
   - the `relay_exec` tool in the worker. The session is injected, not a parameter.
     Remember both the declaration and the `runTurn` handler.
   - access class `session:relay`: owner-only and always enforced
   - sharing a session, or changing its owner, ends its relay binding first
   - only root sessions with an `entra` owner
6. **The rest of issue #27's tool family:** `relay_start_process`,
   `relay_process_status`, `relay_read_log_chunk`, `relay_stop_process`. Then
   artifacts in and out (hash-checked), durable leases, and audit events.
7. **End-to-end encryption** inside the protocol. Both sides already have keys.
   This keeps Azure from reading commands and output.
8. **Periodic token push and presence.** Today the cluster pushes a token only when it connects.
9. **Windows host support.** The `taskkill /T /F` path exists but is untested.
10. **A second provider** (self-hosted WebSocket relay) to prove the contract.
11. **Entra, later:** an Entra group mapped to a `relay` app role on the PilotSwarm
    app registration, checked when a host is added. Fix the roles trap (finding 17) first.

---

## 10. Designs discussed but not built

### Enrollment with a portal URL and a 10-minute code

The host would run `pilotswarm-relay --portal <url> --allow <me> --code <code>` and
call the Web API to preview, redeem, and renew. It was dropped for the profile file
because it needs a public enrollment API, which breaks when the portal is private.

### Entra roles directly on Azure Relay

Rejected. Azure Relay knows nothing about PilotSwarm sessions. Per-person, per-session
role assignments would need the power to grant roles in the subscription, take up to
5 minutes to apply, and need every user in the relay's tenant. Giving a group
"Azure Relay Listener" on the whole namespace is worse: any member could listen on
any host's endpoint and receive part of its commands.

### Cluster in a VNet, relay public

This works with the profile design. The cluster reaches the namespace through a
private endpoint (or one exact firewall name) and never listens. Hosts come in over the
public side. Remaining risks: the keys (the namespace keys matter most), Azure reading
the traffic (item 7 above), and the stolen-profile availability issue (item 1).

### MCP servers on the host (answered, not built)

No "server of servers" is needed. Advertising happens at two levels:

```
Host → PilotSwarm:  `ready` gains  offers: { exec: bool, mcp: ["github", ...] }
                    (host config: pilotswarm-relay --mcp relay-mcp.json [--no-exec])
PilotSwarm → model: one entry per offered server in the session's mcpServers, e.g.
                    "laptop-github": { command: "pilotswarm-relay-mcp", env: { RELAY_MCP_TICKET } }
                    The Copilot runtime runs initialize + tools/list through it;
                    the model sees laptop-github-* tools like any others.
```

- **The shim is a dumb pipe** from stdio to a local socket owned by the PilotSwarm
  worker. The worker holds the keys and does the relay handshake and owner check.
  The ticket ties one shim to one session, one host, and one server.
- **On the relay:** after `host_ok`, the cluster sends `open_mcp { session, server }`.
  The host starts that server, and the connection then carries its JSON-RPC messages.
  Closing the connection kills the server.
- **Chosen: one entry per server, not an aggregator.** Every MCP feature passes through
  unchanged. The cost: a host adding a server changes the session config, which
  triggers a rebind.
- **Agents opt in** with a new frontmatter switch (for example `relayMcpServers: true`).
  System agents never get them.
- **Security:**
  - an MCP-only host (`--no-exec`) needs much less trust than `relay_exec`
  - tool descriptions and results are untrusted; prefix descriptions with the host name
  - block sampling and elicitation from host servers in v1
  - these tools would inherit PilotSwarm's auto-approve

---

## 11. Cleanup (only when done for good)

```
az group delete -n <resource group> --subscription <subscription id>
rm -rf ~/.config/pilotswarm-relay
```
