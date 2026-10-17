# Local signed-proxy authentication example

Open a public landing page, select a demo persona, then enter the real portal
at `/portal/`. The proxy owns an opaque browser cookie and injects a short-lived
RS256 assertion only on its server-to-portal request. The portal uses its
existing JWT verifier and authorization policy. The browser never receives
the assertion or invents an access token.

**This is a local persona demo, not a production identity service.** Anyone
on the machine can choose a persona, including the demo administrator.
Use only a trusted machine and trusted local services. Do not expose either
listener or use production credentials.

## Run

Start from the repository's [local setup](../../docs/quickstart/local.md):
installed workspace dependencies, Node 24 or later, an existing private `.env`
with local database/model settings, and the normal local PostgreSQL setup.
No Azure or Kubernetes infrastructure is required.

```bash
# Starts local services, builds assets and owns both proxy and portal processes.
PS_LOCAL_AUTH_MODE=proxy scripts/local-pilotswarm.sh up

# Stops the example processes. Local PostgreSQL is retained by the normal runner.
scripts/local-pilotswarm.sh down
```

Open <http://127.0.0.1:3001/> and select **Sign in to the demo**. Choose Alice.
The form posts a cookie-bound CSRF token, rotates the cookie, and redirects to
<http://127.0.0.1:3001/portal/>. Select Bob in a different browser profile or
private context to demonstrate separate users. Ordinary tabs share cookies.
The unchanged default `scripts/local-pilotswarm.sh up` uses dev auth and its
per-tab persona selection instead.

| Option | Default | Meaning |
|---|---|---|
| `PORTAL_BASE_PATH` | `/portal` in example mode | `/`, `/portal`, or a nested canonical path such as `/tools/agents` |
| `PS_LOCAL_PROXY_PORTAL_PORT` | `3002` | Fixed loopback upstream portal, distinct from the public proxy port |
| `PS_LOCAL_PROXY_SESSION_TTL` | `900` | Authenticated session lifetime in seconds, from 1 to 3,600 |
| `PS_LOCAL_AUTH_MODE` | `dev` | Explicit `proxy` enables this example; it does not rewrite dev auth |

The ordinary local runner's `PORT` setting selects the proxy port. For example:

```bash
PORTAL_BASE_PATH=/tools/agents PS_LOCAL_AUTH_MODE=proxy scripts/local-pilotswarm.sh restart
```

With dependencies, database and server/browser builds already prepared, the
standalone runner is also available:

```bash
node --env-file=.env examples/proxy-auth/run.mjs --demo \
  --port 3001 --portal-port 3002 --base-path /portal --session-ttl 900
```

It never installs or builds implicitly. Ctrl+C stops both servers. Failed
startup tears down the listeners and child it created. It reports readiness
only after real upstream health, signed admission and unsigned refusal.
Restarting discards keys and sessions, so old cookies no longer authenticate.

## Trust and security boundaries

| Boundary | Behavior |
|---|---|
| Host and target | Exact configured `127.0.0.1` Host on every route; fixed upstream, issuer, audience and JWKS. No request-selected destination. |
| CSRF | Exact Origin on POST/PUT/PATCH/DELETE and both socket upgrades. Login/logout also require a synchronizer token bound to the cookie. OPTIONS and unknown verbs are refused. |
| Cookie | Host-only, `Path=/`, HttpOnly, SameSite=Strict. Loopback HTTP omits Secure; HTTPS use of the lifecycle helper requires an explicit in-memory certificate/key and adds Secure. |
| Identity | Incoming bearer, identity/assertion and forwarding headers are not copied. The proxy injects only its own assertion and fixed forwarding metadata. |
| Authorization | Ada is an administrator; Alice/Bob are users; Denied carries an unrecognized role. A valid signature does not override portal authorization. |
| Lifetime | Login rotates the session ID. Logout/expiry revoke state before closing existing requests and sockets. Later cookie replay fails. |
| Bounds | At most 100 sessions and 8 active operations per session by default, bounded bodies and upstream timeouts. Helper options are validated. |
| Paths | Exact base boundaries; safe local return targets only. Share-capability tokens never enter login returns. |

Cookies are not isolated by port, and `Path` is not an access-control boundary.
Trust the entire local origin and its sibling services. The example's
`/example-auth/` routes use a cookie at `/` so it also reaches the prefixed
portal and both sockets. Do not weaken that into a second, ambiguous cookie.
A first cross-site navigation can withhold a Strict cookie; the same-origin
login page allows a safe retry instead of treating public metadata as sign-in.

The portal itself does **not** enforce WebSocket Origin. A production proxy
that introduces browser cookies must enforce Host, Origin and CSRF before
forwarding or injecting identity. The example uses signed JWTs; it never
enables unsigned header mode. A private Unix-socket test fixture demonstrates
that mode separately, but is not a production isolation design and does not
protect against other processes with the same local UID.

The proxy's auth-form GET may allocate a bounded pre-session and CSRF token;
HEAD does not. GET/HEAD never log in or log out. Portal reads may perform
existing cache or authorization-audit bookkeeping; protected writes remain
on unsafe methods. Keep this distinction when adding a new upstream route.

## Tests

Use the repository's existing runners:

```bash
node --test packages/app/web/test/proxy-auth-example.test.mjs
cd packages/app
npx playwright test --config web/playwright.config.mjs web/test/e2e/proxy-auth-example.spec.mjs
```

The Node and browser cookie/form cases use the real proxy and JWT verifier
with a synthetic upstream API. They do not prove full portal ownership.
The separately credentialed SDK suite
`portal-proxy-integration.test.js` runs the actual portal, workers and public
API against isolated PostgreSQL schemas at root/simple/nested bases:

```bash
# From the repository root:
./scripts/run-tests.sh --suite=portal-proxy-integration
```

Full browser workspace, model execution and deployment checks remain distinct
from the synthetic fixture. Never label a mocked response a real model turn.
