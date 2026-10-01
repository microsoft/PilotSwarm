#!/usr/bin/env node
// OSS Node deploy orchestrator entry point (Phase 1 skeleton).
//
// Drives the same end-state as the enterprise deployment orchestrator (Bicep + image push +
// Flux Storage Bucket manifest delivery + rollout verify) without any enterprise dependency.
//
// Stdlib-only Node, no shell:true, multi-platform (Windows / macOS / Linux).
// Spec: .paw/work/oss-deploy-script/Spec.md
//
// Phase 1 implements env loading, preflight, --steps dispatch, and a `noop` sentinel
// step. Real stages (build/push/bicep/manifests/rollout) are wired in later phases.

import {
  loadEnv,
  log,
  assertCli,
  assertSubscription,
  resolveImageTag,
  stagingDir,
  validateService,
  validateEnv,
  validateDeployInstance,
  run,
} from "./lib/common.mjs";
import { resolveSteps, defaultPipelineFor } from "./lib/stages.mjs";
import { buildImage } from "./lib/build-image.mjs";
import { pushImage, refreshAzureOidcLogin } from "./lib/push-image.mjs";
import { deployBicep } from "./lib/deploy-bicep.mjs";
import { loadCache as loadBicepOutputsCache } from "./lib/bicep-outputs-cache.mjs";
import { composeDerivedEnv } from "./lib/compose-env.mjs";
import { stageManifests } from "./lib/stage-manifests.mjs";
import { publishManifests } from "./lib/publish-manifests.mjs";
import { waitRollout } from "./lib/wait-rollout.mjs";
import { seedSecrets } from "./lib/seed-secrets.mjs";
import { ensureWorkloadGroupMembership } from "./lib/group-membership.mjs";
import { SERVICE_IMAGE_INFO, ALL_SEQUENCE, ALL_MODE_MODULES } from "./lib/service-info.mjs";
import {
  EDGE_MODES,
  TLS_SOURCES,
  validateRequiredEnv,
  applyStubKeys,
  unsupportedEdgeTlsReason,
  edgeModeTransitionReason,
  requiresEdgeModeValidation,
  parseDeployedEdgeModeLookup,
} from "./lib/overlay-contracts.mjs";
import { configureServiceEnv, loadDeployManifest } from "./lib/services-manifest.mjs";
import { resolveDatabaseSecretVersions } from "./lib/database-secrets.mjs";
import { ensurePortForwardCertificate } from "./lib/port-forward-certificate.mjs";
import { WORKSPACES_SERVICE, workspacesEnabled } from "./lib/workspaces.mjs";

// ───────────────────────── Arg parsing ─────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {
    steps: null,
    region: null,
    imageTag: null,
    envOverlays: [],
    instance: null,
    clean: false,
    force: false,
    forceModules: [],
    replacePools: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      flags.help = true;
    } else if (a === "--clean") {
      flags.clean = true;
    } else if (a === "--force") {
      flags.force = true;
    } else if (a === "--replace-pools") {
      flags.replacePools = true;
    } else if (a.startsWith("--force-module=")) {
      const value = a.slice("--force-module=".length);
      if (!value) throw new Error("--force-module requires a module name (got empty value)");
      flags.forceModules.push(value);
    } else if (a === "--force-module") {
      const value = args[++i];
      if (!value) throw new Error("--force-module requires a module name (e.g. --force-module portal)");
      flags.forceModules.push(value);
    } else if (a.startsWith("--steps=")) {
      flags.steps = a.slice("--steps=".length);
    } else if (a === "--steps") {
      flags.steps = args[++i];
    } else if (a.startsWith("--region=")) {
      flags.region = a.slice("--region=".length);
    } else if (a === "--region") {
      flags.region = args[++i];
    } else if (a.startsWith("--image-tag=")) {
      flags.imageTag = a.slice("--image-tag=".length);
    } else if (a === "--image-tag") {
      flags.imageTag = args[++i];
    } else if (a.startsWith("--instance=")) {
      const value = a.slice("--instance=".length);
      if (!value) throw new Error("--instance requires a name (got empty value)");
      if (flags.instance !== null) throw new Error("--instance may be specified only once");
      flags.instance = value;
    } else if (a === "--instance") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--instance requires a name (e.g. --instance my-repo)");
      }
      if (flags.instance !== null) throw new Error("--instance may be specified only once");
      flags.instance = value;
    // Node reserves --env-file for its own runtime, so the deploy CLI uses
    // --env-overlay for a file that is composed after the script starts.
    } else if (a.startsWith("--env-overlay=")) {
      const value = a.slice("--env-overlay=".length);
      if (!value) throw new Error("--env-overlay requires a path (got empty value)");
      flags.envOverlays.push(value);
    } else if (a === "--env-overlay") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--env-overlay requires a path (e.g. --env-overlay ../composition/worker.env)");
      }
      flags.envOverlays.push(value);
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (flags.help) return { help: true };

  if (positional.length < 2) {
    throw new Error(
      "Usage: npm run deploy -- <service> <env> [flags]\n" +
        "  <service>    worker | repo-cache | portal | base-infra | global-infra | horizondb | pls-anchor | cert-manager | cert-manager-issuers | all\n" +
        "  <env>        local env name created with `npm run deploy:new-env`\n" +
        "Flags: --steps, --region, --image-tag, --instance, --env-overlay, --clean, --force, --replace-pools, --help",
    );
  }

  const [service, envName, ...extra] = positional;
  if (extra.length) throw new Error(`Unexpected positional args: ${extra.join(" ")}`);

  return { service, envName, ...flags };
}

function printHelp() {
  process.stdout.write(
    [
      "OSS Node deploy orchestrator for PilotSwarm (additive to enterprise path).",
      "",
      "Usage:",
      "  npm run deploy -- <service> <env> [flags]",
      "",
      "Services:  worker | repo-cache | portal | base-infra | global-infra | horizondb | pls-anchor | cert-manager | cert-manager-issuers | all",
      "           ('all' runs the canonical end-to-end sequence:",
      "            global-infra → base-infra → horizondb → pls-anchor → cert-manager → cert-manager-issuers → worker → repo-cache → portal,",
      "            applying --steps to each as appropriate. pls-anchor is skipped",
      "            when EDGE_MODE is not afd; cert-manager services are skipped",
      "            on the akv (enterprise) TLS_SOURCE path; repo-cache is skipped",
      "            unless WORKSPACES_ENABLED=true.)",
      "Envs:      a local env name created with `npm run deploy:new-env`",
      "",
      "Flags:",
      "  --steps <list>      Comma-separated subset of: build,bicep,seed-secrets,push,render,manifests,rollout",
      "                      (or just 'noop' for env-load + preflight only).",
      "                      Default: full pipeline for service.",
      "  --region <name>     Override LOCATION from <env>.env (e.g. westus3).",
      "  --image-tag <tag>   Explicit image tag. Default: <env>-<short-sha>[-dirty].",
      "  --instance <name>    Instance name for services that deploy repeated resources.",
      "  --env-overlay <path> Overlay an external KEY=VALUE file on the local env.",
      "                      Repeat in precedence order; later files win.",
      "                      Relative paths resolve from the current working directory.",
      "  --clean             Wipe deploy/.tmp/<service>[-<instance>]-<env>/ before running.",
      "  --force             Ignore deploy markers; redeploy every Bicep module even if",
      "                      its template + rendered params are unchanged since last success.",
      "  --force-module <m>  Force-redeploy a single named Bicep module (e.g. portal,",
      "                      pls-anchor). Repeatable. Lighter-touch than --force when only",
      "                      one module needs to retry past its deploy marker (e.g. recover",
      "                      from an out-of-band Bicep tweak or RBAC propagation race).",
      "  --replace-pools     Allow the base-infra agent-pool preflight to REPLACE a fleet",
      "                      node pool whose IMMUTABLE shape changed (vmSize, osType/osSKU,",
      "                      osDisk*). Without it, such a change aborts the deploy with a",
      "                      warning. DESTRUCTIVE: the pool is deleted (nodes drain +",
      "                      destroy) and recreated, so its fleet goes down + cold-reseeds.",
      "  --help, -h          Show this help.",
      "",
      "Spec: .paw/work/oss-deploy-script/Spec.md",
      "",
      "Notes:",
      "  • VPN_GATEWAY_ENABLED=true adds 45+ min to the first `bicep` step",
      "    and ~$450/mo (VpnGw2AZ + Private DNS Resolver) to the running stamp.",
      "    Coexists with the AFD edge mode — does NOT replace it. See",
      "    deploy/providers/azure/envs/template.env for the full env-var roster and the",
      "    AKV-only constraint.",
      "",
    ].join("\n"),
  );
}

function readDeployedEdgeMode({ envName, env }) {
  if (!env.RESOURCE_GROUP || !env.LOCATION) return null;
  const deploymentName = `base-infra-${envName}-${env.LOCATION.replace(/[^a-zA-Z0-9-]/g, "")}`;
  const result = run(
    "az",
    [
      "deployment",
      "group",
      "show",
      "--resource-group",
      env.RESOURCE_GROUP,
      "--name",
      deploymentName,
      "--query",
      "{output:properties.outputs.edgeMode.value,parameter:properties.parameters.edgeMode.value}",
      "--output",
      "json",
    ],
    { capture: true, allowFail: true },
  );
  return parseDeployedEdgeModeLookup({ ...result, deploymentName });
}

// ───────────────────────── Stage runner ─────────────────────────

async function renderServiceManifests(ctx) {
  if (ctx.service === "worker" || ctx.service === "portal") {
    resolveDatabaseSecretVersions(ctx.env);
  }
  const imageInfo = SERVICE_IMAGE_INFO[ctx.service];
  if (imageInfo && ctx.env.ACR_LOGIN_SERVER) {
    ctx.env.IMAGE = `${ctx.env.ACR_LOGIN_SERVER}/${imageInfo.dockerImageRepo}:${ctx.imageTag}`;
  }
  await configureServiceEnv({
    service: ctx.service,
    env: ctx.env,
    phase: "manifests",
    imageTag: ctx.imageTag,
    imageTagExplicit: ctx.imageTagExplicit,
    envOverlays: ctx.envOverlays,
  });
  return stageManifests({
    service: ctx.service,
    envName: ctx.envName,
    env: ctx.env,
    stagingDir: ctx.stagingDir,
  });
}

// A GitHub Actions run signs in to Azure once, with an OIDC assertion that
// expires within minutes. The first call to another Azure service (Key
// Vault, storage, AKS) after a long step then fails: on the stamp, a 10-minute
// base-infra bicep step made the next seed-secrets step fail. These steps sign
// in again first; push and manifests do it themselves, right before their
// uploads. A local run keeps its own login (no OIDC request URL).
const STAGES_THAT_SIGN_IN_AGAIN = new Set(["bicep", "seed-secrets", "rollout"]);

async function runStage(name, ctx) {
  if (STAGES_THAT_SIGN_IN_AGAIN.has(name)) await refreshAzureOidcLogin(ctx.env, `the ${name} step`);
  switch (name) {
    case "noop":
      // Phase 1 sentinel: env load + preflight already done before we got here.
      log("ok", "noop: env loaded, preflight passed.");
      return;
    case "build":
      if (!SERVICE_IMAGE_INFO[ctx.service]) {
        log("info", `No container image for service '${ctx.service}'; skipping build.`);
        return;
      }

      assertCli("docker", "https://docs.docker.com/get-docker/ (must include buildx)");
      await buildImage({
        service: ctx.service,
        envName: ctx.envName,
        imageTag: ctx.imageTag,
        stagingDir: ctx.stagingDir,
        env: ctx.env,
      });
      return;
    case "push":
      if (!SERVICE_IMAGE_INFO[ctx.service]) {
        log("info", `No container image for service '${ctx.service}'; skipping push.`);
        return;
      }
      assertCli("oras", "https://oras.land/docs/installation", ["version"]);
      await pushImage({
        service: ctx.service,
        envName: ctx.envName,
        imageTag: ctx.imageTag,
        env: ctx.env,
        stagingDir: ctx.stagingDir,
      });
      return;
    case "bicep":
      await deployBicep({
        service: ctx.service,
        envName: ctx.envName,
        env: ctx.env,
        region: ctx.region,
        stagingDir: ctx.stagingDir,
        moduleListOverride: ctx.moduleListOverride,
        force: ctx.force,
        forceModules: ctx.forceModules,
        replacePools: ctx.replacePools,
      });
      // Re-run composition: a fresh `all` run starts with an empty outputs
      // cache, so the startup pass at line ~258 had nothing to compose.
      // Now that bicep merged BaseInfra outputs (POSTGRES_FQDN /
      // BLOB_CONTAINER_ENDPOINT / POSTGRES_AAD_ADMIN_PRINCIPAL_NAME) into
      // the in-process env map, derive DATABASE_URL et al. so the
      // subsequent manifests stage finds them.
      composeDerivedEnv(ctx.env, {
        includeGenericWorkerDefaults: ctx.service === "worker",
      });
      if (ctx.service === "portal") {
        ensurePortForwardCertificate(ctx.env);
      }
      return;
    case "seed-secrets":
      await seedSecrets({
        service: ctx.service,
        envName: ctx.envName,
        env: ctx.env,
      });
      return;
    case "workload-group":
      await ensureWorkloadGroupMembership({
        envName: ctx.envName,
        env: ctx.env,
      });
      return;
    case "render": {
      const stagedServiceRoot = await renderServiceManifests(ctx);
      log("ok", `Rendered manifests without publishing: ${stagedServiceRoot}`);
      return;
    }
    case "manifests": {
      const stagedServiceRoot = await renderServiceManifests(ctx);
      await publishManifests({
        service: ctx.service,
        envName: ctx.envName,
        env: ctx.env,
        stagedServiceRoot,
      });
      return;
    }
    case "rollout":
      assertCli("kubectl", "https://kubernetes.io/docs/tasks/tools/", ["version", "--client"]);
      assertCli(
        "flux",
        "https://fluxcd.io/flux/installation/#install-the-flux-cli (winget install FluxCD.Flux / brew install fluxcd/tap/flux)",
        ["--version"],
      );
      await waitRollout({
        service: ctx.service,
        envName: ctx.envName,
        env: ctx.env,
        imageTag: ctx.imageTag,
        stagingDir: ctx.stagingDir,
      });
      return;
    default:
      throw new Error(`Unknown stage: ${name}`);
  }
}

// ───────────────────────── Main ─────────────────────────

// TODO(maintainability): main() has grown to ~280 lines and now mixes
// (a) arg parsing, (b) env composition + alias mapping (FR-022),
// (c) mode validation (edgeMode/tlsSource matrix), (d) per-mode env
// stubbing, and (e) the per-step dispatch loop. Extracting (b)+(c)+(d)
// into a `composeAndValidateEnv(parsed, env)` helper that returns a
// frozen env map would shrink main() back to a readable orchestrator
// shell. Holding off in this PR to keep the diff scoped to behavior
// changes; tracked as a follow-up so future contributors don't keep
// piling onto main().
async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  const {
    service,
    envName,
    steps,
    region,
    imageTag,
    envOverlays,
    instance,
    clean,
    force,
    forceModules,
    replacePools,
  } = parsed;

  // 1) Validate inputs (accepts the virtual `all` aggregate)
  validateService(service);
  validateEnv(envName);
  if (instance !== null) validateDeployInstance(instance);
  const serviceManifest = service === "all"
    ? null
    : loadDeployManifest().services[service];
  if (serviceManifest?.instanceRequired && !instance) {
    throw new Error(`Service '${service}' requires --instance <name>.`);
  }
  if (service === "all" && instance) {
    throw new Error("--instance cannot be used with the 'all' aggregate.");
  }

  // 2) Load env (FR-004) — single shared map so Bicep outputs cascade across
  // services in `all` mode (e.g. BaseInfra → Worker/Portal).
  const { env, sources } = loadEnv(envName, { overlayEnvFiles: envOverlays });
  if (region) env.LOCATION = region; // CLI override
  if (instance) env.DEPLOY_INSTANCE = instance; // explicit CLI input wins over overlays
  if (sources.local) {
    log("info", `Loaded local env: ${sources.local}`);
  } else {
    log("info", `Loaded canonical stamp env without a local stub: ${sources.stampEnvFile}`);
  }
  for (const overlay of sources.overlays) {
    log("info", `Applied external env overlay: ${overlay}`);
  }

  // 3a) Load any cached Bicep outputs from previous runs in this env. This lets
  // single-service runs (e.g. `worker mytestenv`) re-use upstream
  // GlobalInfra/BaseInfra outputs without re-deploying the whole chain
  // in-process. Cached values do NOT override env-file or CLI values.
  // `--clean` (or deleting deploy/.tmp/<env>/bicep-outputs.cache.json) busts it.
  loadBicepOutputsCache(envName, env);

  // 3b) Compose derived env values (DATABASE_URL, AZURE_STORAGE_ACCOUNT_URL,
  // PILOTSWARM_CMS_FACTS_DATABASE_URL, PILOTSWARM_DB_AAD_USER) from
  // BaseInfra Bicep outputs already in env. This handles single-service
  // re-runs that load values from the outputs cache. For first-time `all`
  // runs the cache starts empty; composeDerivedEnv is invoked again after
  // each successful bicep stage in runStage() so manifests-stage env
  // substitution sees the composed values.
  composeDerivedEnv(env, {
    includeGenericWorkerDefaults: service === "worker" || service === "all",
  });
  if (service !== "all") {
    await configureServiceEnv({
      service,
      env,
      envOverlays: sources.overlays,
    });
  }

  // 4) Preflight CLIs (EC-1)
  assertCli("az", "https://aka.ms/azcli (winget install Microsoft.AzureCLI / brew install azure-cli)");

  // 4a) Edge-mode + TLS-source validation + globalinfra skip.
  // EDGE_MODE drives whether AFD is provisioned. `afd` (default) provisions
  // Front Door + Private Link to the AppGw private FE. `private` skips AFD
  // entirely — the GlobalInfra service is a no-op and we drop it from the
  // sequence. Single-service `deploy globalinfra` invocations short-circuit
  // with an explanatory message.
  //
  // TLS_SOURCE drives where the portal TLS cert comes from. `letsencrypt`
  // (default) uses cert-manager + LE prod ACME; `akv` uses a registered AKV
  // issuer + the bicep cert deployment script. cert-manager / LE always
  // produces a publicly-trusted cert, which is what AFD+PL requires.
  const edgeMode = (env.EDGE_MODE || "afd").toLowerCase();
  if (!EDGE_MODES.includes(edgeMode)) {
    log("err", `EDGE_MODE='${env.EDGE_MODE}' is not one of ${EDGE_MODES.join(", ")}. Set it in deploy/envs/${envName}.env or local override.`);
    process.exit(1);
  }
  env.EDGE_MODE = edgeMode;

  const tlsSource = (env.TLS_SOURCE || "letsencrypt").toLowerCase();
  if (!TLS_SOURCES.includes(tlsSource)) {
    log("err", `TLS_SOURCE='${env.TLS_SOURCE}' is not one of ${TLS_SOURCES.join(", ")}. Set it in deploy/envs/${envName}.env or local override.`);
    process.exit(1);
  }
  env.TLS_SOURCE = tlsSource;

  // Defense-in-depth: enforce the centralized edge/TLS matrix used by both
  // the scaffolder and deploy path.
  const unsupportedReason = unsupportedEdgeTlsReason(edgeMode, tlsSource);
  if (unsupportedReason) {
    log(
      "err",
      `Unsupported combination EDGE_MODE='${edgeMode}' + TLS_SOURCE='${tlsSource}': ${unsupportedReason}`,
    );
    process.exit(1);
  }

  // TODO(maintainability): the two early-return mode-skip blocks below
  // duplicate logic also encoded in the SERVICE_MODE_SKIP filter at the
  // `all` aggregate (search for `svc === "global-infra"` further down).
  // A single `serviceSkippedInMode(service, edgeMode, tlsSource)` helper
  // shared by both the singleton entry and the all-aggregate filter
  // would prevent the two from drifting. Not refactoring in this PR to
  // keep the diff minimal; flagged so it stays on the radar.
  if (service === "global-infra" && edgeMode !== "afd") {
    log(
      "ok",
      `EDGE_MODE='${edgeMode}' — GlobalInfra (Front Door) is not provisioned in this mode. Nothing to do.`,
    );
    return;
  }

  if (service === "horizondb" && String(env.HORIZONDB_ENABLED).toLowerCase() !== "true") {
    log("ok", "HORIZONDB_ENABLED=false — HorizonDB is not provisioned for this stamp.");
    return;
  }

  // The repo pod exists only for session workspaces (lib/workspaces.mjs).
  if (service === WORKSPACES_SERVICE && !workspacesEnabled(env)) {
    log("ok", `WORKSPACES_ENABLED=false — '${WORKSPACES_SERVICE}' is not deployed for this stamp.`);
    return;
  }

  // cert-manager + cert-manager-issuers ship the OSS Let's Encrypt path.
  // Skip them entirely when TLS_SOURCE != letsencrypt (enterprise / akv path).
  if (
    (service === "cert-manager" || service === "cert-manager-issuers") &&
    tlsSource !== "letsencrypt"
  ) {
    log(
      "ok",
      `TLS_SOURCE='${tlsSource}' — '${service}' is not provisioned in this mode (only on the OSS letsencrypt path). Nothing to do.`,
    );
    return;
  }

  // pls-anchor anchors the AppGw private-FE listener that materialises the
  // hidden Private Link Service backing AFD's Private Endpoint. With no AFD
  // (EDGE_MODE != afd) there is no AppGw / no PE / nothing to anchor — skip.
  if (service === "pls-anchor" && edgeMode !== "afd") {
    log(
      "ok",
      `EDGE_MODE='${edgeMode}' — 'pls-anchor' is not provisioned in this mode (only on the AFD edge path). Nothing to do.`,
    );
    return;
  }

  // 4b) Contract-driven pre-deploy validation. Single source of truth:
  // deploy/scripts/lib/overlay-contracts.mjs. The contract table owns
  // which keys are required per (EDGE_MODE × TLS_SOURCE) and which
  // off-path keys get auto-stubbed to `unused`. Adding a new overlay key
  // is a one-line change in overlay-contracts.mjs — deploy.mjs picks it
  // up automatically.
  const requestedSteps = steps == null
    ? null
    : new Set(String(steps).split(",").map((step) => step.trim()).filter(Boolean));
  const deploysPortalRuntime =
    (service === "portal" || service === "all")
    && (
      requestedSteps === null
      || requestedSteps.has("manifests")
      || requestedSteps.has("rollout")
      || requestedSteps.has("noop")
    );
  const { missing: missingRequired, combo: comboErrors } = validateRequiredEnv({
    edgeMode,
    tlsSource,
    env,
    enforcePortalAuth: deploysPortalRuntime,
  });
  if (missingRequired.length > 0 || comboErrors.length > 0) {
    if (missingRequired.length > 0) {
      log(
        "err",
        `EDGE_MODE='${edgeMode}' TLS_SOURCE='${tlsSource}' requires ${missingRequired.join(", ")} to be set ` +
          `(per overlay contract in deploy/scripts/lib/overlay-contracts.mjs). ` +
          `Re-run \`npm run deploy:new-env -- ${envName} --force\` and supply values when prompted, ` +
          `or hand-edit deploy/envs/local/${envName}/.env.`,
      );
    }
    // Combination errors render as named errors with a targeted remediation
    // hint rather than the generic missing-key scaffolder guidance.
    for (const e of comboErrors) {
      log("err", `[${e.code}] ${e.message} ${e.hint}`);
    }
    process.exit(1);
  }
  // TLS_SOURCE=akv no longer requires a pre-set PORTAL_TLS_ISSUER_NAME —
  // Portal bicep now defaults it to OneCertV2-PublicCA (afd) or
  // OneCertV2-PrivateCA (private) per the reference deployment pattern
  // and registers the issuer on the AKV automatically. Operators can still
  // override via env if they want a different registered CA.
  // TLS_SOURCE=akv-selfsigned uses the AKV built-in `Self` issuer; no
  // CA registration required.

  // 4c) Stub `unused`-sentinel values for params that are required by
  // Bicep templates / kustomize overlays but irrelevant on the active
  // edge / tls path. Driven by the contract table so adding a new off-
  // path key is a one-line change in overlay-contracts.mjs.
  //
  // TODO(maintainability): the literal string `"unused"` is a sentinel
  // that survives all the way into rendered bicep parameter files. It
  // works because the receiving modules guard their use behind the same
  // edgeMode/tlsSource gates, but a typo'd guard on either side would
  // silently smuggle the sentinel into a real ARM API call. Replacing
  // these with a named `MODE_STUB` constant + a render-params assertion
  // that fails-closed when `MODE_STUB` reaches a *required* (i.e.
  // unguarded) bicep param would surface drift loudly. Tracked as a
  // follow-up; behaviour today is correct.
  applyStubKeys({ edgeMode, tlsSource, env });
  // BaseInfra's parameter template always references FRONT_DOOR_ID, even
  // when the selected edge mode does not provision Front Door.
  if (edgeMode !== "afd") env.FRONT_DOOR_ID = "";
  // PORTAL_HOSTNAME is required in `private` (validated via the contract
  // through HOST + PRIVATE_DNS_ZONE, which compose to the FQDN) and unused
  // in `afd` (bicep derives it from the AFD endpoint). Stub when blank so
  // render-params succeeds. Kept inline because it is a bicep param, not
  // an overlay-selector key.
  if (!env.PORTAL_HOSTNAME) env.PORTAL_HOSTNAME = "unused";
  // PORTAL_TLS_ISSUER_NAME stub — kept inline (not in contract) because
  // it's a bicep param, not an overlay key.
  if (!env.PORTAL_TLS_ISSUER_NAME || String(env.PORTAL_TLS_ISSUER_NAME).trim() === "") {
    env.PORTAL_TLS_ISSUER_NAME = "unused";
  }

  assertCli("git", "https://git-scm.com/downloads");
  // docker / kubectl / oras checked lazily by the stages that need them.

  // 5) Subscription pin (FR-005)
  assertSubscription(env.SUBSCRIPTION_ID);
  if (requiresEdgeModeValidation(steps)) {
    const deployedEdgeMode = readDeployedEdgeMode({ envName, env });
    const transitionReason = edgeModeTransitionReason(deployedEdgeMode, edgeMode);
    if (transitionReason) {
      throw new Error(transitionReason);
    }
  }

  // 6) Resolve image tag (FR-017) — shared across services in `all` mode so
  // worker and portal end up tagged consistently in one bring-up invocation.
  const resolvedTag = resolveImageTag({ envName, explicit: imageTag });
  const imageTagExplicit = imageTag !== null;
  log("info", `Image tag: ${resolvedTag}`);

  // 7) Branch: `all` aggregates over the canonical sequence; otherwise single service.
  if (service === "all") {
    await runAll({
      envName,
      env,
      envOverlays: sources.overlays,
      instance,
      steps,
      imageTag: resolvedTag,
      imageTagExplicit,
      clean,
      force,
      forceModules,
      replacePools,
      edgeMode,
    });
  } else {
    await runOneService({
      service,
      envName,
      env,
      envOverlays: sources.overlays,
      instance,
      steps,
      imageTag: resolvedTag,
      imageTagExplicit,
      clean,
      force,
      forceModules,
      replacePools,
      moduleListOverride: null,
    });
  }

  log("ok", "Deploy script completed successfully.");
}

// Single-service execution path. Used directly for explicit `<service> <env>`
// invocations and as the per-service step inside `runAll`.
async function runOneService({
  service,
  envName,
  env,
  envOverlays,
  instance,
  steps,
  imageTag,
  imageTagExplicit,
  clean,
  force,
  forceModules,
  replacePools,
  moduleListOverride,
}) {
  if (clean) {
    const { rmSync } = await import("node:fs");
    const dir = stagingDir(service, envName, instance);
    rmSync(dir, { recursive: true, force: true });
    log("info", `Cleaned staging dir: ${dir}`);
  }
  const stage = stagingDir(service, envName, instance);

  const resolvedSteps = resolveSteps(steps, service);
  // In `all` mode, intersect requested steps with this service's default
  // pipeline so e.g. `--steps manifests,rollout` skips infra services rather
  // than failing on missing overlays.
  const effectiveSteps = moduleListOverride
    ? resolvedSteps.filter((s) => defaultPipelineFor(service).includes(s))
    : resolvedSteps;

  if (effectiveSteps.length === 0) {
    log("info", `[${service}] no applicable steps for this service; skipping.`);
    return;
  }

  log(
    "info",
    `Service=${service} Env=${envName} Region=${env.LOCATION} Steps=${effectiveSteps.join(",")}`,
  );

  const ctx = {
    service,
    envName,
    env,
    region: env.LOCATION,
    imageTag,
    imageTagExplicit,
    envOverlays,
    stagingDir: stage,
    moduleListOverride,
    force,
    forceModules,
    replacePools,
  };

  for (const step of effectiveSteps) {
    log("step", `=== [${service}] ${step} ===`);
    try {
      await runStage(step, ctx);
    } catch (e) {
      log("err", `Failed: ${service} ${step}`);
      process.stderr.write(`${e.message}\n`);
      const instanceArg = instance ? ` --instance ${JSON.stringify(instance)}` : "";
      const overlayArg = envOverlays
        .map((overlay) => ` --env-overlay ${JSON.stringify(overlay)}`)
        .join("");
      process.stderr.write(
        `\nRe-run with: npm run deploy -- ${service} ${envName} --steps ${step}${instanceArg}${overlayArg}\n`,
      );
      process.exit(1);
    }
  }
}

// Canonical end-to-end bring-up: iterate ALL_SEQUENCE, sharing the same env
// map across services so Bicep outputs from earlier services (e.g. ACR login
// server, deployment storage account) cascade forward. Each service deploys
// only its own Bicep module (ALL_MODE_MODULES) — dependencies were deployed
// by an earlier item in the same invocation.
async function runAll({
  envName,
  env,
  envOverlays,
  steps,
  imageTag,
  imageTagExplicit,
  clean,
  force,
  forceModules,
  replacePools,
  edgeMode,
}) {
  // Drop globalinfra from the sequence when AFD is disabled — the service is
  // entirely AFD provisioning and would otherwise create an empty RG with no
  // resources. Mirrors the single-service short-circuit above. cert-manager
  // + cert-manager-issuers are dropped on the akv (enterprise) path for the same
  // reason — those services exist only to serve the OSS Let's Encrypt path.
  const tlsSource = (env.TLS_SOURCE || "letsencrypt").toLowerCase();
  const sequence = ALL_SEQUENCE.filter(
    (svc) => !(svc === "global-infra" && edgeMode !== "afd"),
  ).filter(
    (svc) => !(svc === "pls-anchor" && edgeMode !== "afd"),
  ).filter(
    (svc) => !(svc === "horizondb" && String(env.HORIZONDB_ENABLED).toLowerCase() !== "true"),
  ).filter(
    (svc) => !(svc === WORKSPACES_SERVICE && !workspacesEnabled(env)),
  ).filter(
    (svc) =>
      !((svc === "cert-manager" || svc === "cert-manager-issuers") && tlsSource !== "letsencrypt"),
  );
  log("info", `=== Bring-up sequence: ${sequence.join(" → ")} ===`);
  for (const svc of sequence) {
    await runOneService({
      service: svc,
      envName,
      env,
      envOverlays,
      instance: null,
      steps,
      imageTag,
      imageTagExplicit,
      clean,
      force,
      forceModules,
      replacePools,
      moduleListOverride: ALL_MODE_MODULES[svc],
    });
  }
}

main().catch((e) => {
  process.stderr.write(`${e.stack ?? e.message}\n`);
  process.exit(1);
});
