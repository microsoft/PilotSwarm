import { test } from "node:test";
import assert from "node:assert/strict";

import { dockerBuildInvocation } from "../lib/build-image.mjs";

const baseInput = {
  localTag: "example-worker:test",
  dockerfileAbs: "C:\\repo\\deploy\\Dockerfile.worker",
};

test("docker build uses the Dockerfile registry default when no override is configured", () => {
  const invocation = dockerBuildInvocation(baseInput);

  assert.equal(invocation.args.includes("--build-arg"), false);
  assert.deepEqual(invocation.envOverrides, {});
});

test("docker build forwards an optional npm registry without placing its URL in arguments", () => {
  const registry = "https://registry.example.test/npm/";
  const invocation = dockerBuildInvocation({
    ...baseInput,
    npmRegistry: `  ${registry}  `,
  });

  assert.deepEqual(
    invocation.args.slice(-3),
    ["--build-arg", "NPM_REGISTRY", invocation.args.at(-1)],
  );
  assert.equal(invocation.args.includes(registry), false);
  assert.deepEqual(invocation.envOverrides, { NPM_REGISTRY: registry });
});
