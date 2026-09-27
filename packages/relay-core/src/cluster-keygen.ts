#!/usr/bin/env node
/**
 * pilotswarm-relay-cluster-keygen: make a PilotSwarm cluster's key pair.
 *
 *   <dir>/cluster.key   private key. Stays with the cluster (mode 600).
 *   <dir>/cluster.pub   public key. Give it to relay hosts: --trust-cluster cluster.pub
 *
 * usage: pilotswarm-relay-cluster-keygen <dir>
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateKeyPair } from "./keys.js";

const dir = process.argv[2];
if (!dir) {
    process.stderr.write("usage: pilotswarm-relay-cluster-keygen <dir>\n");
    process.exit(2);
}
const keyFile = path.join(dir, "cluster.key");
const pubFile = path.join(dir, "cluster.pub");
if (existsSync(keyFile)) {
    process.stderr.write(`pilotswarm-relay-cluster-keygen: ${keyFile} already exists; not overwriting\n`);
    process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const key = generateKeyPair(); // EC P-256
writeFileSync(keyFile, key.privateKeyPem, { mode: 0o600 });
writeFileSync(pubFile, key.publicKeyPem, { mode: 0o644 });
process.stdout.write(`private key: ${keyFile}\npublic key:  ${pubFile}\nfingerprint: ${key.fingerprint}\n`);
