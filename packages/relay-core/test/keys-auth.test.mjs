// P-256 keys and both handshake signatures, without any transport.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { ClusterSigner, HostSigner, TrustedClusters, checkHostProof, generateKeyPair } from "../dist/index.js";

const ours = generateKeyPair();
const cluster = new ClusterSigner(ours.privateKeyPem);
const trusted = TrustedClusters.fromPublicKeyPems([ours.publicKeyPem]);

test("keys are EC P-256 and signatures are 64-byte r||s", () => {
    assert.match(ours.privateKeyPem, /BEGIN PRIVATE KEY/);
    assert.equal(cluster.fingerprint, ours.fingerprint);
    assert.equal(Buffer.from(cluster.signChallenge("ns/ep", "c1"), "base64url").length, 64);
});

test("a cluster signature checks out only for the same cluster, endpoint, and challenge", () => {
    const signature = cluster.signChallenge("ns/ep", "c1");
    assert.ok(trusted.check(cluster.fingerprint, signature, "ns/ep", "c1"));
    assert.equal(trusted.check(cluster.fingerprint, signature, "ns/other", "c1"), false);
    assert.equal(trusted.check(cluster.fingerprint, signature, "ns/ep", "c2"), false);
    const other = new ClusterSigner(generateKeyPair().privateKeyPem);
    assert.equal(trusted.check(other.fingerprint, other.signChallenge("ns/ep", "c1"), "ns/ep", "c1"), false);
    assert.equal(trusted.check(other.fingerprint, signature, "ns/ep", "c1"), false);
});

test("a host proof checks out only for its own key, this cluster, endpoint, and challenge", () => {
    const host = new HostSigner(generateKeyPair().privateKeyPem);
    const fields = { host: host.fingerprint, cluster: cluster.fingerprint, endpointId: "ns/ep", challenge: "c1" };
    const signature = host.signChallenge(cluster.fingerprint, "ns/ep", "c1");
    assert.ok(checkHostProof(host.publicKeyPem, fields, signature));
    assert.equal(checkHostProof(host.publicKeyPem, { ...fields, cluster: "sha256:someone-else" }, signature), false);
    assert.equal(checkHostProof(host.publicKeyPem, { ...fields, endpointId: "ns/other" }, signature), false);
    assert.equal(checkHostProof(host.publicKeyPem, { ...fields, challenge: "c2" }, signature), false);
    const other = new HostSigner(generateKeyPair().privateKeyPem);
    // The right signature, but the key does not match the fingerprint it claims.
    assert.equal(checkHostProof(other.publicKeyPem, fields, signature), false);
});

test("junk input is a plain no, never a throw", () => {
    assert.equal(trusted.check(undefined, undefined, "ns/ep", "c1"), false);
    assert.equal(trusted.check(cluster.fingerprint, "not base64 !!", "ns/ep", "c1"), false);
    assert.equal(trusted.check(cluster.fingerprint, "", "ns/ep", "c1"), false);
    assert.equal(checkHostProof("not a pem", { host: "x", cluster: "y", endpointId: "z", challenge: "c" }, "sig"), false);
});

test("only P-256 keys are accepted", () => {
    const ed = generateKeyPairSync("ed25519");
    assert.throws(() => TrustedClusters.fromPublicKeyPems([ed.publicKey.export({ type: "spki", format: "pem" })]), /P-256/);
    assert.throws(() => new ClusterSigner(ed.privateKey.export({ type: "pkcs8", format: "pem" })), /P-256/);
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    assert.throws(() => new HostSigner(p384.privateKey.export({ type: "pkcs8", format: "pem" })), /P-256/);
    assert.throws(() => TrustedClusters.fromPublicKeyPems([]), /no trusted cluster keys/);
});
