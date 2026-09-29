#!/usr/bin/env node
/**
 * Git credential helper for session clones (docs/proposals/session-workspaces.md, 5.4).
 *
 * The repo service sets it in each clone's own .git/config, after an empty
 * helper that clears every inherited one:
 *
 *   credential.helper =                      (clears global and URL-scoped helpers)
 *   credential.helper = !node <this file>    (with REPO_SERVICE_URL set)
 *   credential.useHttpPath = true            (git sends the repo path too)
 *
 * On `get`, it asks the repo service for a short-lived token. The service
 * answers only for its repos' own remotes, so a push to any other host gets
 * no token. `store` and `erase` do nothing: the service owns the tokens.
 */
const [action] = process.argv.slice(2);
if (action !== "get") process.exit(0);

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const fields = Object.fromEntries(input.split("\n").filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

const serviceUrl = process.env.REPO_SERVICE_URL;
if (!serviceUrl || !fields.host) process.exit(0);
try {
    const response = await fetch(new URL("/v1/token", serviceUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol: fields.protocol, host: fields.host, path: fields.path }),
        signal: AbortSignal.timeout(10_000),
    });
    const answer = response.ok ? await response.json() : {};
    if (answer.username && answer.password) {
        process.stdout.write(`username=${answer.username}\npassword=${answer.password}\n`);
    }
} catch {
    // No answer: git falls through to "no credentials" and the push fails.
}
