/**
 * What a compute target says it offers
 * (docs/proposals/compute-providers.md, "Capabilities").
 *
 * Two things are tested here. One is the naming of a model a target offers
 * itself, which has to sit beside PilotSwarm's own `provider:model` names
 * without ever being mistaken for one. The other is what the worker keeps
 * of an advertisement, which arrives from an untrusted host and is both
 * stored and shown to people.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    MAX_COMPUTE_ADVERTISEMENT_BYTES,
    computeTargetNameFor,
    parseComputeTargetName,
    resolveComputeTargetName,
    validateComputeTargetName,
    MAX_COMPUTE_HOST_MODELS,
    advertisedHostModels,
    normalizeAdvertisement,
    parseTargetModelRef,
    targetMayOfferHostModels,
    targetModelRef,
} from "../../dist/compute.js";
import { askHostModels } from "../../dist/compute-runtime.js";
import { createProcessComputeProvider } from "../../dist/compute-process.js";
import { COMPUTE_ADVERTISEMENT_MAX_BYTES } from "../../dist/migrations/compute-targets-0084.js";

test("a target's own model has a name of its own that no provider model can take", () => {
    assert.equal(targetModelRef("shared/my-box", "some-model"), "@shared/my-box:some-model");
    assert.deepEqual(parseTargetModelRef("@shared/my-box:some-model"), { target: "shared/my-box", model: "some-model" });
    // A target's own name holds no colon, so the first one always separates;
    // a model name may hold as many more as it likes.
    assert.deepEqual(parseTargetModelRef("@a@b.com/box:vendor:model:1"), { target: "a@b.com/box", model: "vendor:model:1" });

    // Provider names never start with "@", so an ordinary qualified name is
    // never read as a target's.
    assert.equal(parseTargetModelRef("anthropic:claude-sonnet-4-6"), null);
    assert.equal(parseTargetModelRef("gpt-5"), null);
    assert.equal(parseTargetModelRef(""), null);
    assert.equal(parseTargetModelRef(undefined), null);
    assert.equal(parseTargetModelRef(42), null);
    // Nothing missing on either side, and the target must be a real name.
    assert.equal(parseTargetModelRef("@:model"), null);
    assert.equal(parseTargetModelRef("@shared/my-box:"), null);
    assert.equal(parseTargetModelRef("@shared/my-box"), null);
    assert.equal(parseTargetModelRef("@shared/my box:model"), null);
    assert.equal(parseTargetModelRef("@my-box:model"), null, "a target is always named in full");
});

test("a target is named after whoever owns it", () => {
    assert.deepEqual(parseComputeTargetName("alice@example.com/gpu-sandbox"), { owner: "alice@example.com", label: "gpu-sandbox" });
    assert.deepEqual(parseComputeTargetName("shared/build-pool"), { owner: "shared", label: "build-pool" });
    assert.equal(parseComputeTargetName("bare"), null);
    assert.equal(validateComputeTargetName("bare").ok, false);
    assert.equal(validateComputeTargetName("/leading").ok, false);
    assert.equal(validateComputeTargetName("trailing/").ok, false);
    assert.equal(validateComputeTargetName("shared/has space").ok, false);
    assert.equal(validateComputeTargetName("shared/a:b").ok, false, "a colon would break a model name");
    assert.equal(validateComputeTargetName("shared/ok").ok, true);

    // PilotSwarm builds the owner part; a registrant supplies only a label.
    const alice = { email: "Alice@Example.com" };
    assert.deepEqual(computeTargetNameFor("personal", "gpu-sandbox", alice), { ok: true, name: "alice@example.com/gpu-sandbox" });
    assert.deepEqual(computeTargetNameFor("shared", "build-pool", alice), { ok: true, name: "shared/build-pool" });
    assert.equal(computeTargetNameFor("personal", "bad label", alice).ok, false);
    // No sign-in address is a refusal, never an invented owner.
    const none = computeTargetNameFor("personal", "box", { email: null });
    assert.equal(none.ok, false);
    assert.match(none.message, /sign-in address/);
    assert.equal(computeTargetNameFor("personal", "box", { email: "shared" }).ok, false,
        "nobody can sign in as the word the shared space uses");
});

test("a bare label means the caller's own target, then the shared one", () => {
    const alice = { email: "alice@example.com" };
    assert.deepEqual(resolveComputeTargetName("box", alice), ["alice@example.com/box", "shared/box"]);
    assert.deepEqual(resolveComputeTargetName("box", null), ["shared/box"],
        "with nobody signed in there is only the shared space");
    assert.deepEqual(resolveComputeTargetName("shared/box", alice), ["shared/box"], "a whole name is taken as it is");
    assert.deepEqual(resolveComputeTargetName("bob@example.com/box", alice), ["bob@example.com/box"]);
    assert.deepEqual(resolveComputeTargetName("not a label", alice), []);
    assert.deepEqual(resolveComputeTargetName("", alice), []);
});

test("only a personal target on a provider whose hosts have model access offers models", () => {
    const offers = { os: ["linux"], sandboxed: false, files: "none", offersModels: true };
    const plain = { os: ["linux"], sandboxed: false, files: "none" };
    assert.equal(targetMayOfferHostModels({ class: "personal" }, offers), true);
    assert.equal(targetMayOfferHostModels({ class: "shared" }, offers), false, "rule M1");
    assert.equal(targetMayOfferHostModels({ class: "personal" }, plain), false);
    assert.equal(targetMayOfferHostModels(null, offers), false);
    assert.equal(targetMayOfferHostModels({ class: "personal" }, undefined), false);

    const advertised = { observedAt: "2026-01-01T00:00:00.000Z", models: [{ id: "m1" }] };
    assert.deepEqual(advertisedHostModels({ class: "personal", advertised }), [{ id: "m1" }]);
    assert.deepEqual(advertisedHostModels({ class: "shared", advertised }), [],
        "a shared target offers no models however it advertises itself");
    assert.deepEqual(advertisedHostModels({ class: "personal", advertised: null }), []);
    assert.deepEqual(advertisedHostModels(undefined), []);
});

test("an advertisement keeps only what it should, and cannot grow without limit", () => {
    assert.deepEqual(normalizeAdvertisement(null), {});
    assert.deepEqual(normalizeAdvertisement("models"), {});
    assert.deepEqual(normalizeAdvertisement([{ id: "m" }]), {}, "an array is not an advertisement");

    const kept = normalizeAdvertisement({
        models: [{ id: " m1 ", name: " First " }, { id: "m1" }, { id: "" }, { id: 7 }, null, { id: "m2" }],
        os: "  linux  ",
        details: { tools: "git", bad: 7 },
        secretField: "dropped",
        advertisedAt: "ignored",
    });
    assert.deepEqual(kept, {
        models: [{ id: "m1", name: "First" }, { id: "m2" }],
        os: "linux",
        details: { tools: "git" },
    });
    assert.equal("secretField" in kept, false, "unknown fields are dropped");

    // Bounded in every direction a host could push on.
    const many = normalizeAdvertisement({ models: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })) });
    assert.ok(many.models.length <= MAX_COMPUTE_HOST_MODELS);
    const long = normalizeAdvertisement({ models: [{ id: "x".repeat(500) }, { id: "ok", name: "y".repeat(500) }] });
    assert.deepEqual(long.models, [{ id: "ok", name: "y".repeat(200) }], "an over-long id is dropped, an over-long name is cut");
    assert.equal(normalizeAdvertisement({ os: "z".repeat(100) }).os.length, 40);

    const huge = normalizeAdvertisement({ models: Array.from({ length: 200 }, (_, i) => ({ id: `${i}-${"m".repeat(190)}` })) });
    assert.ok(Buffer.byteLength(JSON.stringify(huge), "utf8") <= MAX_COMPUTE_ADVERTISEMENT_BYTES,
        "models are dropped until the whole advertisement fits");
    assert.ok(huge.models.length > 0, "and not all of them");
});

test("the worker's cap and the one the database enforces are the same number", () => {
    assert.equal(COMPUTE_ADVERTISEMENT_MAX_BYTES, MAX_COMPUTE_ADVERTISEMENT_BYTES);
});

test("asking a runtime what it offers never throws and keeps only well-formed models", async () => {
    assert.deepEqual(await askHostModels(null), []);
    assert.deepEqual(await askHostModels({}), [], "a runtime that cannot be asked offers nothing");
    assert.deepEqual(await askHostModels({ listModels: () => { throw new Error("no"); } }), []);
    assert.deepEqual(await askHostModels({ listModels: async () => { throw new Error("no"); } }), []);
    assert.deepEqual(await askHostModels({ listModels: async () => "not a list" }), []);

    assert.deepEqual(
        await askHostModels({
            listModels: async () => [
                { id: " a ", name: " A ", capabilities: { limits: {} } },
                { id: "b" },
                { name: "no id" },
                "nonsense",
                null,
            ],
        }),
        [{ id: "a", name: "A" }, { id: "b" }],
        "only id and name are taken; everything else the runtime says is left behind",
    );

    const flood = await askHostModels({ listModels: async () => Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}` })) });
    assert.equal(flood.length, MAX_COMPUTE_HOST_MODELS);
});

test("a provider says in its own code whether its hosts have model access", () => {
    assert.equal(createProcessComputeProvider().capabilities.offersModels, undefined,
        "a runtime on the worker's own machine has no model access the worker did not give it");
    assert.equal(createProcessComputeProvider({ offersModels: true }).capabilities.offersModels, true);
});

test("a provider describes a host it does not know without failing", async () => {
    const provider = createProcessComputeProvider();
    const described = await provider.describeHost({
        target: { id: "t", name: "t", kind: "process", class: "personal", ownerUserId: 1, displayName: null, config: {}, enabled: true },
        host: { kind: "process", id: "gone", incarnation: "gone" },
        signal: new AbortController().signal,
    });
    assert.equal(described.os, process.platform);
    assert.equal(described.models, undefined, "models come from the runtime, not from the provider");
});
