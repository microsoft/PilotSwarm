import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelProviderRegistry } from "../packages/sdk/src/model-providers.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export function testModelCatalogPath(env = process.env, root = repoRoot) {
    // Match SDK Vitest's workspace cwd and PS override. Its default overrides
    // MODEL_PROVIDERS_PATH; checking that unused catalog would give false assurance.
    return env.PS_MODEL_PROVIDERS_PATH
        ? resolve(root, "packages/sdk", env.PS_MODEL_PROVIDERS_PATH)
        : resolve(root, "packages/sdk/test/fixtures/model-providers.test.json");
}

class ModelPreflightError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

async function nativeClient(options) {
    const { CopilotClient } = await import("@github/copilot-sdk");
    return new CopilotClient(options);
}

async function offeredModels(providerId, gitHubToken, createClient) {
    const directory = await mkdtemp(join(tmpdir(), "pilotswarm-test-models-"));
    let client;
    let stage = "authentication";
    try {
        client = await createClient({
            gitHubToken,
            useLoggedInUser: false,
            workingDirectory: directory,
            baseDirectory: directory,
            logLevel: "error",
        });
        await client.start();
        if (!(await client.getAuthStatus()).isAuthenticated) {
            throw new ModelPreflightError("COPILOT_AUTHENTICATION",
                `Copilot authentication failed for ${providerId}; check the explicitly configured Copilot credential.`);
        }
        stage = "discovery";
        return await client.listModels();
    } catch (error) {
        if (error instanceof ModelPreflightError) throw error;
        // Native errors may include request/configuration details. Never echo them.
        throw new ModelPreflightError(stage === "authentication" ? "COPILOT_AUTHENTICATION" : "COPILOT_DISCOVERY",
            `Copilot ${stage} failed for ${providerId}; check authentication and service availability. This is not a model-absence result.`);
    } finally {
        try {
            const errors = await client?.stop();
            if (errors?.length) throw new Error("Native client did not stop cleanly");
        } catch {
            throw new ModelPreflightError("COPILOT_CLEANUP", `Copilot preflight client cleanup failed for ${providerId}.`);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
}

export async function validateTestModels({ catalog, env = process.env, unitOnly = false, createClient = nativeClient }) {
    const registry = new ModelProviderRegistry(catalog, { keepUncredentialed: true });
    for (const [setting, model] of [
        ["PS_TEST_FORCE_MODEL/TEST_FORCE_MODEL", env.PS_TEST_FORCE_MODEL || env.TEST_FORCE_MODEL],
        ["PS_INTERRUPT_TEST_MODEL", env.PS_INTERRUPT_TEST_MODEL],
    ]) {
        if (model && !registry.getDescriptor(model)) {
            throw new ModelPreflightError("TEST_MODEL_NOT_CONFIGURED",
                `Test model override ${setting}=${model} is not configured in the effective SDK test catalog.`);
        }
    }
    const providers = registry.allProviders.filter(provider => provider.type === "github" && provider.models.length);
    if (!providers.length) return { status: "not-applicable", checkedModels: [] };
    const credentials = providers.map(provider => {
        const value = provider.githubToken;
        return (value?.startsWith("env:") ? env[value.slice(4)] : value) || env.GITHUB_TOKEN;
    });
    if (unitOnly) {
        if (credentials.some(Boolean)) {
            throw new ModelPreflightError("TEST_MODEL_UNIT_CREDENTIAL",
                "--unit-only requires a credential-free environment; it is not a live-preflight bypass.");
        }
        return { status: "skipped", reason: "credential-free-unit-only", checkedModels: [] };
    }
    const missingCredentials = providers.filter((_, index) => !credentials[index]);
    if (missingCredentials.length) {
        throw new ModelPreflightError("COPILOT_CREDENTIAL_MISSING",
            `Copilot availability requires an explicit githubToken/GITHUB_TOKEN for: ${missingCredentials.map(provider => provider.id).join(", ")}. Use --unit-only only for credential-free checks, not live qualification.`);
    }
    const checkedModels = [];
    for (const [index, provider] of providers.entries()) {
        const advertised = await offeredModels(provider.id, credentials[index], createClient);
        const problems = [];
        for (const model of registry.allModels.filter(model => model.providerId === provider.id)) {
            const offered = advertised.find(entry => entry.id === model.modelName);
            if (!offered) problems.push(`${model.qualifiedName}: not advertised`);
            else if (offered.policy && offered.policy.state !== "enabled") {
                problems.push(`${model.qualifiedName}: policy ${offered.policy.state ?? "unknown"}`);
            }
            checkedModels.push(model.qualifiedName);
        }
        if (problems.length) {
            throw new ModelPreflightError("COPILOT_MODEL_UNAVAILABLE",
                `Configured Copilot test models unavailable: ${problems.join("; ")}. Update the live-test fixture or PS_MODEL_PROVIDERS_PATH override to advertised, enabled models. Do not substitute silently; create/getCurrent is not serving evidence.`);
        }
    }
    return { status: "passed", checkedModels };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--unit-only")) throw new Error("Unsupported argument");
    const catalog = JSON.parse(readFileSync(testModelCatalogPath(), "utf8"));
    // Show configured identifiers only, never credentials, endpoints or the offered catalog.
    console.log(`SDK test default model: ${catalog.defaultModel}`);
    for (const provider of catalog.providers) {
        console.log(`Configured test models (${provider.type}): ${provider.models.map(model =>
            `${provider.id}:${typeof model === "string" ? model : model.name}`).join(", ")}`);
    }
    const result = await validateTestModels({ catalog, unitOnly: args.includes("--unit-only") });
    console.log(`Copilot model availability: ${result.status.toUpperCase()}${result.reason ? ` (${result.reason})` : ""}; ${result.checkedModels.length} configured models checked.`);
    console.log("Availability is not inference or live qualification; root API usage must independently match the requested model.");
    if (process.env.HORIZON_EMBED_MODEL) {
        console.log(`HorizonDB embedding model: ${process.env.HORIZON_EMBED_MODEL} (rotation also uses its -v2 deployment alias).`);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof ModelPreflightError ? error.message
            : "Test model preflight failed; check arguments and the effective SDK test catalog privately. No live availability was established.");
        process.exitCode = 1;
    });
}
