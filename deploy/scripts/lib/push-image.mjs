// Image push component (Phase 2, FR-007).
//
// In-process zlib.createGunzip() decompresses <staging>/<repo>.tar.gz to
// <staging>/<repo>.tar (no host `gunzip` CLI required), then passes the .tar
// directly to `oras cp --from-oci-layout <tar>:<tag> <acr>/<repo>:<tag>`
// (matches deploy/providers/azure/services/common/scripts/UploadContainer.sh:31 reference shape).
//
// Uses a short-lived ACR refresh token from Azure CLI to authenticate ORAS
// directly. This avoids `az acr login` calling Docker's credential helper,
// which can fail or hang on unattended runners. EC-7: aborts with a
// copy-pasteable hint if the prerequisite tarball is missing.

import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { run, resolveCli, log } from "./common.mjs";
import { SERVICE_IMAGE_INFO } from "./service-info.mjs";

export async function pushImage({ service, envName, imageTag, env, stagingDir: stage }) {
  const info = SERVICE_IMAGE_INFO[service];
  if (!info) {
    throw new Error(
      `Service '${service}' has no image to push (only worker/portal have container images).`,
    );
  }
  const { dockerImageRepo } = info;

  const acrName = env.ACR_NAME;
  const acrLoginServer = env.ACR_LOGIN_SERVER;
  if (!acrName || !acrLoginServer) {
    throw new Error(
      "ACR_NAME and ACR_LOGIN_SERVER must be set in the env map.\n" +
        "Either run --steps bicep first (BaseInfra outputs populate them), or seed them\n" +
        "in deploy/envs/local/<env>/.env (FR-021).",
    );
  }

  const gzPath = join(stage, `${dockerImageRepo}.tar.gz`);
  if (!existsSync(gzPath)) {
    // EC-7: missing prerequisite tarball.
    throw new Error(
      `Image tarball not found at ${gzPath}.\n` +
        `Run --steps build first:\n` +
        `  npm run deploy -- ${service} ${envName} --steps build,push`,
    );
  }
  const tarPath = join(stage, `${dockerImageRepo}.tar`);

  log("info", `zlib gunzip → ${tarPath}`);
  await gunzipFile(gzPath, tarPath);

  const dest = `${acrLoginServer}/${dockerImageRepo}:${imageTag}`;
  log("info", "Requesting ACR refresh token for ORAS.");
  let auth;
  try {
    const result = run("az", ["acr", "login", "--name", acrName, "--expose-token", "--output", "json"], { capture: true });
    auth = JSON.parse(result.stdout);
    if (!auth.accessToken || auth.loginServer?.toLowerCase() !== acrLoginServer.toLowerCase()) {
      throw new Error("Missing or mismatched ACR token response fields");
    }
  } catch {
    throw new Error("ACR token acquisition failed.");
  }

  // Keep the ORAS credential outside Docker's global config, and remove it
  // even when upload fails. The directory is private to this process.
  const authDir = mkdtempSync(join(tmpdir(), "pilotswarm-oras-"));
  const authFile = join(authDir, "config.json");
  try {
    const login = spawnSync(resolveCli("oras"), [
      "login", "--username", "00000000-0000-0000-0000-000000000000",
      "--password-stdin", "--registry-config", authFile, acrLoginServer,
    ], { input: auth.accessToken, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    if (login.error || login.status !== 0) throw new Error("ORAS registry login failed.");
    log("info", `oras cp --from-oci-layout ${tarPath}:${imageTag} → ${dest}`);
    run("oras", ["cp", "--from-oci-layout", `${tarPath}:${imageTag}`, "--to-registry-config", authFile, dest]);
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
  log("ok", `Pushed ${dest}`);
}

// In-process gunzip: avoids any host `gunzip` CLI (matches CodeResearch §7).
function gunzipFile(srcPath, dstPath) {
  return new Promise((resolve, reject) => {
    const src = createReadStream(srcPath);
    const dst = createWriteStream(dstPath);
    const gz = createGunzip();
    src.on("error", reject);
    gz.on("error", reject);
    dst.on("error", reject);
    dst.on("finish", resolve);
    src.pipe(gz).pipe(dst);
  });
}
