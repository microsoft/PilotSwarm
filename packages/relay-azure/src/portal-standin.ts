#!/usr/bin/env node
/**
 * Stand-in for the PilotSwarm portal's "hosts" page, so the spike can run
 * without changing PilotSwarm. A real portal does the same three things
 * behind a signed-in Web API call.
 *
 *   add-host --owner <email> [--owner-oid <oid>] --out <file>
 *       Creates the host's endpoint, writes its profile, records it as pending.
 *   list-hosts
 *   revoke-host <hostId>
 *       Marks it revoked and deletes its endpoint. A connected host drops in ~20 s.
 *
 * Settings (environment): RELAY_* (see provider.ts), RELAY_CLUSTER_DIR
 * (holds cluster.pub and hosts.json), PORTAL_URL (shown to the host).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { FileHostRegistry, fingerprintOfPem, issueProfile } from "pilotswarm-relay-core";
import { writeFileSync } from "node:fs";
import { azureRelayProvider } from "./provider.js";

function fail(message: string): never {
    process.stderr.write(`portal: ${message}\n`);
    process.exit(2);
}

function required(name: string): string {
    return process.env[name] || fail(`${name} is not set`);
}

function option(argv: string[], name: string): string | undefined {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
}

const clusterDir = required("RELAY_CLUSTER_DIR");
const registry = new FileHostRegistry(path.join(clusterDir, "hosts.json"));
const [command, ...rest] = process.argv.slice(2);

async function addHost(): Promise<void> {
    const email = option(rest, "--owner") ?? fail("--owner <email> is required");
    const oid = option(rest, "--owner-oid");
    const out = option(rest, "--out") ?? fail("--out <file> is required");
    const clusterPublicKey = readFileSync(path.join(clusterDir, "cluster.pub"), "utf8");

    const provisioner = azureRelayProvider.createProvisioner(process.env);
    const { endpointId, grant } = await provisioner.createHostEndpoint();
    const { profile, record } = issueProfile({
        portal: process.env.PORTAL_URL ?? "https://portal.invalid",
        issuedTo: { provider: "entra", subject: oid ?? `unknown-oid:${email}`, email },
        clusterPublicKeys: [clusterPublicKey],
        provider: azureRelayProvider.name,
        endpointId,
        grant,
    });
    registry.add(record);
    writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });

    process.stdout.write(
        [
            `host ${record.hostId} added for ${email}`,
            `  relay endpoint     ${endpointId}`,
            `  cluster key        ${fingerprintOfPem(clusterPublicKey)}   <- the host's consent screen must show this`,
            `  activate before    ${new Date(profile.activation.expiresAt).toLocaleTimeString()} (10 minutes)`,
            `  profile            ${out}  (a secret until activated; mode 600)`,
            "",
            `On the host:  pilotswarm-relay --profile ${path.basename(out)}`,
            "",
        ].join("\n"),
    );
}

function listHosts(): void {
    const rows = registry.list();
    if (rows.length === 0) {
        process.stdout.write("no hosts\n");
        return;
    }
    for (const r of rows) {
        const key = r.hostKey ? r.hostKey.fingerprint.slice(0, 20) + "…" : "-";
        const where = r.host ? `${r.host.user}@${r.host.hostname}` : "-";
        process.stdout.write(`${r.hostId}  ${r.status.padEnd(8)} ${r.issuedTo.email ?? r.issuedTo.subject}  ${r.endpointId.split("/")[1]}  key ${key}  ${where}\n`);
    }
}

async function revokeHost(): Promise<void> {
    const hostId = rest[0] ?? fail("revoke-host <hostId>");
    const record = registry.revoke(hostId);
    await azureRelayProvider.createProvisioner(process.env).deleteHostEndpoint(record.endpointId);
    process.stdout.write(`host ${hostId} revoked; endpoint ${record.endpointId} deleted. A connected host drops within about 20 s.\n`);
}

const commands: Record<string, () => Promise<void> | void> = { "add-host": addHost, "list-hosts": listHosts, "revoke-host": revokeHost };
const run = commands[command ?? ""] ?? (() => fail("usage: portal add-host --owner <email> [--owner-oid <oid>] --out <file> | list-hosts | revoke-host <hostId>"));
Promise.resolve(run()).catch((error: Error) => fail(error.message));
