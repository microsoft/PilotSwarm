/**
 * The pilotswarm-relay command, for any relay provider. A provider package
 * ships a two-line bin that calls runRelayHost(itsProvider, argv).
 *
 * The host needs one thing: the profile file downloaded from the portal.
 *
 * 1. Read the profile (or this host's saved state from an earlier run)
 * 2. Show a consent screen and wait for "y"
 * 3. Make the host key on first run (it never leaves this machine)
 * 4. Listen through the provider with the profile's credential
 * 5. Accept only the profile's cluster; send the activation secret once;
 *    save fresh credentials the cluster pushes
 * 6. Run commands for the profile's owner only; one log line per command
 * 7. If the endpoint is deleted or the credential refused, stop and say so
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { TrustedClusters } from "./auth.js";
import { describeThisHost, serveConnection, type ServedConnection } from "./exec-host.js";
import { OwnerAllowList } from "./owner-allowlist.js";
import { HostStateStore, parseProfile } from "./profile.js";
import type { GrantedTransport, RelayProvider } from "./provider.js";
import { RelayTransportError, type RelayListener } from "./transport.js";

const USAGE =
    "usage: pilotswarm-relay --profile <file.relay.json> [--allow <email|entra-object-id>] [--yes] [--cwd <dir>] [--state-dir <dir>]\n" +
    "  --profile    the file you downloaded from the portal when you added this host\n" +
    "  --allow      optional check: refuse to start unless the profile is issued to this person\n";

interface CliArgs {
    profileFile: string;
    allow: string[];
    yes: boolean;
    cwd: string;
    stateRoot: string;
}

function fail(message: string, code = 2): never {
    process.stderr.write(`pilotswarm-relay: ${message}\n`);
    process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        profileFile: "",
        allow: [],
        yes: false,
        cwd: process.cwd(),
        stateRoot: path.join(os.homedir(), ".config", "pilotswarm-relay", "host"),
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--profile") args.profileFile = argv[++i] ?? fail("--profile needs a file");
        else if (arg === "--allow") args.allow.push(argv[++i] ?? fail("--allow needs an email or Entra object id"));
        else if (arg === "--yes" || arg === "-y") args.yes = true;
        else if (arg === "--cwd") args.cwd = argv[++i] ?? fail("--cwd needs a directory");
        else if (arg === "--state-dir") args.stateRoot = argv[++i] ?? fail("--state-dir needs a directory");
        else if (arg === "--help" || arg === "-h") {
            process.stdout.write(USAGE);
            process.exit(0);
        } else fail(`unknown argument: ${arg}`);
    }
    if (!args.profileFile) fail(`--profile is required\n${USAGE}`);
    return args;
}

function log(line: string): void {
    const time = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`[${time}] ${line}\n`);
}

async function askConsent(lines: string[], yes: boolean): Promise<boolean> {
    process.stdout.write(["", "================================================================", ...lines, "================================================================", ""].join("\n"));
    if (yes) {
        process.stdout.write(" Accepted with --yes.\n\n");
        return true;
    }
    if (!process.stdin.isTTY) fail("consent needs a terminal; pass --yes to accept without one");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(" Allow? [y/N] ");
    prompt.close();
    return answer.trim().toLowerCase() === "y";
}

export async function runRelayHost(provider: RelayProvider, argv: string[]): Promise<void> {
    const args = parseArgs(argv);

    let store: HostStateStore;
    try {
        const profile = parseProfile(readFileSync(args.profileFile, "utf8"));
        store = HostStateStore.open(args.stateRoot, profile);
    } catch (error) {
        fail(`${args.profileFile}: ${(error as Error).message}`);
    }
    const state = store.state;
    if (state.relay.provider !== provider.name) fail(`the profile is for relay provider '${state.relay.provider}', not '${provider.name}'`);

    const owner = state.issuedTo;
    const allowedOwners = OwnerAllowList.forOwner(owner);
    if (args.allow.length > 0) {
        let expected: OwnerAllowList;
        try {
            expected = OwnerAllowList.parse(args.allow);
        } catch (error) {
            fail(`--allow: ${(error as Error).message}`);
        }
        if (!expected.allows(owner)) fail(`the profile is issued to ${owner.email ?? owner.subject}, who is not on --allow`);
    }
    if (!store.isActivated && Date.now() > Date.parse(state.activation!.expiresAt)) {
        fail(`this profile was never activated and its activation window closed at ${state.activation!.expiresAt}. Download a new one.`, 1);
    }

    let trustedClusters: TrustedClusters;
    let transport: GrantedTransport;
    try {
        trustedClusters = TrustedClusters.fromPublicKeyPems(state.cluster.publicKeys);
        transport = provider.createHostTransport(state.relay.grant, log);
    } catch (error) {
        fail(`${provider.name}: ${(error as Error).message}`);
    }
    if (transport.endpointId !== state.relay.endpointId) fail("the profile's relay credential is for a different endpoint");

    const host = describeThisHost(args.cwd);
    const who = host.elevated ? `${host.user}  <-- ROOT. Commands run as root.` : `${host.user} (not elevated)`;
    const activation = store.isActivated
        ? `already activated ${state.activatedAt ?? ""}`.trim()
        : `on first connection; window closes ${new Date(state.activation!.expiresAt).toLocaleTimeString()}`;
    const accepted = await askConsent(
        [
            " PilotSwarm relay: consent",
            "----------------------------------------------------------------",
            ` Profile from     : ${state.portal}`,
            ` Issued to        : ${owner.email ?? owner.subject} (${owner.provider})`,
            ` Trusted cluster  : ${trustedClusters.fingerprints.join("\n                    ")}`,
            ` Relay endpoint   : ${transport.endpointId} (${provider.name})`,
            ` Activation       : ${activation}`,
            ` This machine     : ${host.hostname} (${host.platform} ${host.arch})`,
            ` Commands run as  : ${who}`,
            ` Default folder   : ${args.cwd}`,
            "",
            ` Only the cluster above can connect, and only sessions owned by`,
            ` ${owner.email ?? owner.subject} can run commands. Those sessions can run ANY`,
            " command on this machine, with the rights of the user above.",
            " Check that the cluster fingerprint matches the one the portal showed.",
            "",
            " Press Ctrl+C at any time to stop. Running commands are killed.",
        ],
        args.yes,
    );
    if (!accepted) {
        log("consent refused; nothing was registered");
        process.exit(1);
    }

    const hostSigner = store.hostSigner();
    store.save();
    log(`host key ${hostSigner.fingerprint} (${store.hostKeyFile})`);

    let listener: RelayListener | undefined;
    let stopping = false;
    const served = new Set<ServedConnection>();

    const shutdown = () => {
        if (stopping) process.exit(130);
        stopping = true;
        log("stopping; killing running commands");
        for (const connection of served) connection.stop();
        listener?.close();
        // Give the close frames a moment to reach the relay service.
        setTimeout(() => process.exit(0), 500).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    let backoffMs = 1000;
    while (!stopping) {
        try {
            listener = await transport.listen();
        } catch (error) {
            // These two will not fix themselves by retrying.
            if (error instanceof RelayTransportError && error.kind === "not_found") {
                fail("this host's relay endpoint no longer exists: the portal removed it. Add the host again to get a new profile.", 1);
            }
            if (error instanceof RelayTransportError && error.kind === "unauthorized") {
                fail("the relay refused this host's credential (expired or revoked). Add the host again to get a new profile.", 1);
            }
            log(`could not register with the relay: ${(error as Error).message}`);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            backoffMs = Math.min(backoffMs * 2, 30_000);
            continue;
        }
        backoffMs = 1000;
        log(`listening on ${transport.endpointId} as ${host.user}@${host.hostname} (pid ${process.pid}); outbound only`);

        listener.onConnection((connection) => {
            log(`caller connected (${connection.id.slice(0, 8)})`);
            const handle = serveConnection(connection, {
                host,
                trustedClusters,
                hostSigner,
                endpointId: transport.endpointId,
                allowedOwners,
                activationSecret: () => state.activation?.secret,
                onActivated: () => {
                    state.activation = undefined;
                    state.activatedAt = new Date().toISOString();
                    store.save();
                    log(`activated. The downloaded profile's secret is spent; you may delete ${args.profileFile}`);
                },
                onGrantUpdate: (grant) => {
                    try {
                        transport.refreshGrant(grant);
                    } catch (error) {
                        log(`ignored a credential update: ${(error as Error).message}`);
                        return;
                    }
                    state.relay.grant = grant;
                    store.save();
                    log("the cluster pushed a fresh relay credential; saved");
                },
                log,
            });
            served.add(handle);
            connection.onClose((info) => {
                served.delete(handle);
                log(`caller disconnected (${connection.id.slice(0, 8)}, code ${info.code})`);
            });
        });

        const lost = await new Promise<{ code: number; reason: string }>((resolve) => listener!.onClose(resolve));
        if (!stopping) log(`relay registration lost (code ${lost.code}${lost.reason ? `: ${lost.reason}` : ""}); registering again`);
    }
}
