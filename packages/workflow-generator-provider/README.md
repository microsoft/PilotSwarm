# Workflow Generator provider host

This package is PilotSwarm's transport-neutral provider module contract and
platform-owned HTTP runner. Domain repositories provide modules implementing
`SourceProvider`; they do not implement HTTP routing, authentication, health
probes, request parsing, or process lifecycle.

A plugin module exports:

```js
export default {
  apiVersion: "pilotswarm.workflow-generator-provider/v1",
  id: "example-items",
  createProvider(context) {
    return {
      id: context.id,
      async evaluate(request, { signal }) {
        return {
          discoveries: [{ key: "stable-key", payload: { id: 1 } }],
        };
      },
    };
  },
};
```

Register modules with the runner:

```text
WORKFLOW_GENERATOR_PROVIDER_PLUGINS_JSON=[{"id":"example-items","module":"file:///plugins/example/dist/plugin.js"}]
WORKFLOW_GENERATOR_PROVIDER_HOST_AUTH_TOKEN=<controller-to-runner bearer>
```

The controller registers the platform-owned runner endpoint:

```text
WORKFLOW_GENERATOR_SOURCE_PROVIDERS_JSON=[{"id":"example-items","endpoint":"http://provider-host/providers/example-items/evaluate","tokenEnv":"EXAMPLE_PROVIDER_TOKEN"}]
```

The bearer named by `tokenEnv` must match
`WORKFLOW_GENERATOR_PROVIDER_HOST_AUTH_TOKEN`. During rotation the runner can also accept
`WORKFLOW_GENERATOR_PROVIDER_HOST_PREVIOUS_AUTH_TOKEN`.

The runner enforces `WORKFLOW_GENERATOR_PROVIDER_HOST_EVALUATE_TIMEOUT_MS` (60000 by
default) and aborts the evaluation signal when the request disconnects or the
deadline expires. Providers must pass that signal to their upstream I/O.
Providers must also honor `limits.maxItemsPerCycle`; the runner rejects an
oversized response independently.

On shutdown, the runner stops accepting requests, aborts active evaluations,
waits for their cleanup within a bounded portion of
`WORKFLOW_GENERATOR_PROVIDER_HOST_SHUTDOWN_TIMEOUT_MS`, and then closes provider-level
resources.

Run one trust domain per provider-host process. Module code executes inside the
runner process and can access its environment and identity. Use separate runner
pods when connectors require different credentials or workload identities.

Build the runner image from the repository root:

```powershell
docker build -f packages\workflow-generator-provider\Dockerfile `
  -t pilotswarm-workflow-generator-provider:local .
```

The build defaults to the public npm registry. Environments that require a
mirror can pass `--build-arg NPM_REGISTRY=<registry-url>`.
