import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PORTAL_CONFIG_KEYS } from "../lib/portal-config.mjs";
import { SEEDABLE_SECRET_KEYS } from "../lib/seed-secrets.mjs";
import { OVERLAY_CONTRACTS } from "../lib/overlay-contracts.mjs";
import { stageManifests } from "../lib/stage-manifests.mjs";
import { renderLocalEnv } from "../new-env.mjs";
import { REPO_ROOT } from "../lib/common.mjs";

const KEY = "PORTAL_API_CORS_ALLOWED_ORIGINS";
const ORIGINS = '["https://client.example.com","https://client.example.com:8443"]';
const overlays = [
    ["afd", "letsencrypt"], ["afd", "akv"], ["private", "akv"], ["public", "letsencrypt"],
];
const variants = [undefined, "", "   ", "__PS_UNSET__", "[]", ORIGINS];
const expected = value => String(value ?? "").trim() || "__PS_UNSET__";
const kubectlWorks = spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status === 0;
function env(value, edge, tls) {
    return {
        ...Object.fromEntries(PORTAL_CONFIG_KEYS.map(({ env: key }) => [key, "__PS_UNSET__"])),
        EDGE_MODE: edge, TLS_SOURCE: tls, FOUNDRY_ENDPOINT: "", IMAGE: "registry.example.com/portal:unchanged",
        NAMESPACE: "pilotswarm", KV_NAME: "test-vault",
        WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
        AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
        PORTAL_HOSTNAME: "portal.example.com", PILOTSWARM_USE_MANAGED_IDENTITY: "1",
        AZURE_STORAGE_ACCOUNT_URL: "https://test.blob.core.windows.net/",
        PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://test@database.invalid/test?sslmode=require",
        PILOTSWARM_DB_AAD_USER: "test", DATABASE_URL: "postgresql://test@database.invalid/test?sslmode=require",
        [KEY]: value,
    };
}
function stage(t, value, edge, tls) {
    const stagingDir = mkdtempSync(join(tmpdir(), "ps-cors-render-"));
    t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
    const root = stageManifests({ service: "portal", envName: "test", env: env(value, edge, tls), stagingDir });
    return join(root, "overlays", `${edge}-${tls}`);
}
function render(overlay) {
    const opts = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, KUBECONFIG: "/dev/null" } };
    const yaml = spawnSync("kubectl", ["kustomize", overlay], opts);
    assert.equal(yaml.status, 0, yaml.stderr);
    const json = spawnSync("kubectl", ["annotate", "--local", "-f", "-", "-o", "json", "pilotswarm.dev/render-probe-"],
        { ...opts, input: yaml.stdout });
    assert.equal(json.status, 0, json.stderr);
    const objects = json.stdout.trim().split(/\n(?=\{\n)/).map(text => JSON.parse(text));
    const config = objects.find(obj => obj.kind === "ConfigMap" && obj.metadata.name.startsWith("portal-env-"));
    const deployment = objects.find(obj => obj.kind === "Deployment" && obj.metadata.name === "pilotswarm-portal");
    assert.ok(config);
    assert.ok(deployment);
    return { config, deployment, container: deployment.spec.template.spec.containers.find(c => c.name === "portal") };
}

test("public key is registered once, not seedable as a Secret, and belongs to all overlay contracts", () => {
    assert.equal(PORTAL_CONFIG_KEYS.filter(({ env }) => env === KEY).length, 1);
    assert.ok(!SEEDABLE_SECRET_KEYS.some(({ env }) => env === KEY));
    for (const contract of Object.values(OVERLAY_CONTRACTS)) {
        assert.ok(contract.bicepOutputKeys.includes(KEY));
        assert.ok(!contract.userRequiredEnvKeys.includes(KEY));
    }
    const template = readFileSync(join(REPO_ROOT, "deploy/providers/azure/envs/template.env"), "utf8");
    assert.equal(template.match(new RegExp(`^${KEY}=.*$`, "gm"))?.length, 1);
    assert.match(template, new RegExp(`^${KEY}=$`, "m"));
});
for (const value of variants) {
    test(`maintained scaffold preserves one public JSON string: ${value ?? "(omitted)"}`, () => {
        const output = renderLocalEnv({ name: "test", targets: {}, portalConfig: { [KEY]: value } });
        const lines = output.split("\n").filter(line => line.startsWith(`${KEY}=`));
        assert.equal(lines.length, 1, "no competing template/config block entries");
        // The scaffolder preserves supplied whitespace; manifest staging
        // renders its blank equivalent as the standard unset sentinel.
        assert.equal(lines[0], `${KEY}=${value || "__PS_UNSET__"}`);
    });
}
for (const [edge, tls] of overlays) {
    for (const value of variants) {
        test(`${edge}-${tls}: staged and generated CORS value ${value ?? "(omitted)"}`, t => {
            const overlay = stage(t, value, edge, tls);
            const source = readFileSync(join(overlay, ".env"), "utf8").split("\n").filter(line => line.startsWith(`${KEY}=`));
            assert.deepEqual(source, [`${KEY}=${expected(value)}`]);
            if (!kubectlWorks) { t.skip("kubectl not installed: generated-object coverage unavailable"); return; }
            const { config, container } = render(overlay);
            assert.equal(typeof config.data[KEY], "string");
            assert.equal(config.data[KEY], expected(value));
            assert.equal(config.metadata.namespace, "pilotswarm");
            assert.equal(container.env.filter(e => e.name === KEY).length, 1);
            const explicit = container.env.find(e => e.name === KEY);
            assert.equal(explicit.value, undefined, "no competing literal");
            assert.deepEqual(explicit.valueFrom.configMapKeyRef, { name: config.metadata.name, key: KEY, optional: true });
            assert.equal(container.envFrom[0].configMapRef.name, config.metadata.name);
            assert.equal(container.envFrom[1].secretRef.name, "pilotswarm-portal-secrets");
            for (const name of ["PORTAL_TUI_MODE", "PLUGIN_DIRS", "TLS_CERT_PATH", "TLS_KEY_PATH", "PS_MODEL_PROVIDERS_PATH"]) {
                assert.ok(container.env.some(e => e.name === name), name);
            }
        });
    }
    test(`${edge}-${tls}: list-only change rolls pod references without rebuilding the image`, t => {
        if (!kubectlWorks) { t.skip("kubectl not installed"); return; }
        const a = render(stage(t, ORIGINS, edge, tls));
        const b = render(stage(t, '["https://another.example.com"]', edge, tls));
        assert.notEqual(a.config.metadata.name, b.config.metadata.name);
        assert.notDeepEqual(a.deployment.spec.template, b.deployment.spec.template);
        assert.notDeepEqual(a.container.env, b.container.env);
        assert.notDeepEqual(a.container.envFrom, b.container.envFrom);
        assert.equal(a.container.image, "registry.example.com/portal:unchanged");
        assert.equal(b.container.image, a.container.image);
        const normalized = structuredClone(b.container);
        normalized.env.find(e => e.name === KEY).valueFrom.configMapKeyRef.name = a.config.metadata.name;
        normalized.envFrom[0].configMapRef.name = a.config.metadata.name;
        assert.deepEqual(normalized, a.container, "only the generated reference changes");
    });
}
