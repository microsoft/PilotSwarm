// The profile file, the host's saved state, and the deployment's host registry.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { FileHostRegistry, HostStateStore, describeThisHost, generateKeyPair, issueProfile, parseProfile } from "../dist/index.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "relay-profile-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const cluster = generateKeyPair();
const owner = { provider: "entra", subject: "0f8fad5b-d9cb-469f-a165-70867728950e", email: "alice@example.com" };
const issue = (now = new Date()) =>
    issueProfile({ portal: "https://portal.test", issuedTo: owner, clusterPublicKeys: [cluster.publicKeyPem], provider: "test", endpointId: `ns/s-${Math.random()}`, grant: { token: "t1" }, now });

test("a profile round-trips, and the registry keeps only the secret's hash", () => {
    const { profile, record } = issue();
    assert.deepEqual(parseProfile(JSON.stringify(profile)), profile);
    assert.equal(record.status, "pending");
    assert.equal(JSON.stringify(record).includes(profile.activation.secret), false, "the registry stored the secret itself");
    const window = Date.parse(profile.activation.expiresAt) - Date.parse(profile.issuedAt);
    assert.equal(window, 10 * 60_000);
});

test("broken profiles are refused with a plain reason", () => {
    const { profile } = issue();
    assert.throws(() => parseProfile("{"), /not valid JSON/);
    assert.throws(() => parseProfile(JSON.stringify({ ...profile, version: 2 })), /unsupported profile version/);
    assert.throws(() => parseProfile(JSON.stringify({ ...profile, cluster: { publicKeys: [] } })), /no cluster keys/);
    assert.throws(() => parseProfile(JSON.stringify({ ...profile, activation: undefined })), /no activation secret/);
});

test("activation works once, then the secret is spent", async () => {
    const registry = new FileHostRegistry(path.join(dir, "hosts-once.json"));
    const { profile, record } = issue();
    registry.add(record);
    const hostKey = generateKeyPair();
    const ok = await registry.activate(record.endpointId, profile.activation.secret, hostKey.publicKeyPem, describeThisHost());
    assert.deepEqual(ok, { ok: true });
    assert.equal(await registry.pinnedHostKey(record.endpointId), hostKey.publicKeyPem);
    const again = await registry.activate(record.endpointId, profile.activation.secret, generateKeyPair().publicKeyPem, describeThisHost());
    assert.equal(again.ok, false);
    assert.match(again.reason, /already activated/);
    // Persisted: a second instance on the same file sees the pinned key. The file is mode 600.
    assert.equal(await new FileHostRegistry(registry.file).pinnedHostKey(record.endpointId), hostKey.publicKeyPem);
    assert.equal(statSync(registry.file).mode & 0o777, 0o600);
});

test("wrong secret, expired window, and revoked host are refused", async () => {
    const registry = new FileHostRegistry(path.join(dir, "hosts-refused.json"));
    const key = generateKeyPair().publicKeyPem;

    const a = issue();
    registry.add(a.record);
    assert.match((await registry.activate(a.record.endpointId, "wrong", key, describeThisHost())).reason, /wrong activation secret/);
    assert.equal(registry.get(a.record.hostId).status, "pending");

    const b = issue(new Date(Date.now() - 11 * 60_000));
    registry.add(b.record);
    assert.match((await registry.activate(b.record.endpointId, b.profile.activation.secret, key, describeThisHost())).reason, /activation window closed/);

    const c = issue();
    registry.add(c.record);
    await registry.activate(c.record.endpointId, c.profile.activation.secret, key, describeThisHost());
    registry.revoke(c.record.hostId);
    assert.equal(await registry.pinnedHostKey(c.record.endpointId), undefined, "a revoked host still has a pinned key");
});

test("host state: the host key is made once, and saved state wins over the profile", () => {
    const { profile } = issue();
    const file = path.join(dir, "p.relay.json");
    writeFileSync(file, JSON.stringify(profile));
    const root = path.join(dir, "host-state");

    const first = HostStateStore.open(root, parseProfile(JSON.stringify(profile)));
    const signer = first.hostSigner();
    first.state.relay.grant = { token: "t2" };
    first.state.activation = undefined;
    first.save();
    assert.equal(statSync(first.hostKeyFile).mode & 0o777, 0o600);

    const second = HostStateStore.open(root, profile);
    assert.equal(second.hostSigner().fingerprint, signer.fingerprint, "a second run made a new host key");
    assert.deepEqual(second.state.relay.grant, { token: "t2" }, "the profile's old credential replaced the pushed one");
    assert.equal(second.isActivated, true, "the spent activation secret came back from the profile");
});
