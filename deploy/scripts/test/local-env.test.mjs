// Tests for env name policy + loadEnv resolution rules.
//
// Run: node --test deploy/scripts/test/local-env.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  loadEnv,
  envFilePath,
  templateEnvPath,
  validateLocalEnvName,
  RESERVED_ENV_NAMES,
  REPO_ROOT,
  expandStampEnvDir,
  STAMP_ENV_DIR_TOKEN,
} from "../lib/common.mjs";
import { composeDerivedEnv } from "../lib/compose-env.mjs";
import { DATABASE_URL_KEYS } from "../lib/database-env.mjs";

const ENV_DIR = join(REPO_ROOT, "deploy", "envs");
const LOCAL_DIR = join(ENV_DIR, "local");

// Use a deterministic test name; clean up before/after.
const TEST_NAME = "tstenv";
const TEST_FILE = join(LOCAL_DIR, TEST_NAME, ".env");

function cleanup() {
  const dir = join(LOCAL_DIR, TEST_NAME);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

test("validateLocalEnvName accepts valid names", () => {
  for (const ok of ["a", "foo", "sandbox", "abc123", "x12345678901", "example-test"]) {
    assert.doesNotThrow(() => validateLocalEnvName(ok));
  }
});

test("validateLocalEnvName rejects invalid names", () => {
  for (const bad of ["", "1abc", "ABC", "foo_bar", "foo-", "foo--bar", "x123456789012345", "Foo"]) {
    assert.throws(() => validateLocalEnvName(bad), /Invalid env name/);
  }
});

test("validateLocalEnvName rejects reserved names", () => {
  for (const r of RESERVED_ENV_NAMES) {
    assert.throws(() => validateLocalEnvName(r), /reserved env name/);
  }
});

test("envFilePath resolves local names to deploy/envs/local/<name>/.env", () => {
  assert.equal(envFilePath("foo"), join(ENV_DIR, "local", "foo", ".env"));
});

test("envFilePath rejects reserved names", () => {
  for (const r of RESERVED_ENV_NAMES) {
    assert.throws(() => envFilePath(r), /reserved env name/);
  }
});

test("templateEnvPath points at deploy/providers/azure/envs/template.env", () => {
  assert.equal(templateEnvPath(), join(REPO_ROOT, "deploy", "providers", "azure", "envs", "template.env"));
});

test("loadEnv reads the local env file standalone (no template cascade)", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(
      TEST_FILE,
      [
        "SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000000",
        `RESOURCE_PREFIX=ps${TEST_NAME}`,
        `RESOURCE_GROUP=ps${TEST_NAME}-wus3-rg`,
        "NAMESPACE=pilotswarm",
        "LOCATION=westus3",
        "",
      ].join("\n"),
      "utf8",
    );

    const { env, sources } = loadEnv(TEST_NAME);
    assert.equal(env.RESOURCE_PREFIX, `ps${TEST_NAME}`);
    assert.equal(env.RESOURCE_GROUP, `ps${TEST_NAME}-wus3-rg`);
    assert.equal(env.SUBSCRIPTION_ID, "00000000-0000-0000-0000-000000000000");
    assert.equal(env.NAMESPACE, "pilotswarm");
    assert.equal(env.LOCATION, "westus3");
    assert.equal(env.DEPLOY_PROVIDER, "azure");
    // Sources reflect the standalone read.
    assert.equal(sources.base, null);
    assert.equal(sources.local, TEST_FILE);
  } finally {
    cleanup();
  }
});

test("loadEnv does NOT cascade values from template.env", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    // Write a deliberately sparse local file. Keys present only in
    // template.env (NAMESPACE, AZURE_TENANT_ID, etc.) must NOT leak in.
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=ps" + TEST_NAME + "\n", "utf8");
    const { env } = loadEnv(TEST_NAME);
    assert.equal(env.RESOURCE_PREFIX, `ps${TEST_NAME}`);
    assert.equal(env.NAMESPACE, undefined);
    assert.equal(env.AZURE_TENANT_ID, undefined);
    assert.equal(env.EDGE_MODE, undefined);
  } finally {
    cleanup();
  }
});

test("old local env accepts a process override for newly introduced database keys", () => {
  cleanup();
  const keys = [
    "DEPLOY_POSTGRES",
    "DATABASE_URL_SECRET_NAME",
    "PILOTSWARM_BLOB_USE_MANAGED_IDENTITY",
    ...DATABASE_URL_KEYS,
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=pststenv\n");
    process.env.DEPLOY_POSTGRES = " 0 ";
    process.env.DATABASE_URL_SECRET_NAME = "shared-runtime-url";
    process.env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY = "true";
    for (const key of DATABASE_URL_KEYS) process.env[key] = "******external.invalid/app";
    const { env } = loadEnv(TEST_NAME);
    assert.equal(env.DEPLOY_POSTGRES, "false");
    assert.equal(env.DATABASE_URL_SECRET_NAME, "shared-runtime-url");
    assert.equal(env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY, "true");
    for (const key of DATABASE_URL_KEYS) assert.equal(env[key], process.env[key]);
    assert.equal(env.NAMESPACE, undefined);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    cleanup();
  }
});

test("an old local env without the node-pool and workspaces keys gets their defaults", () => {
  cleanup();
  const keys = ["WORKSPACES_ENABLED", "USER_POOL_MIN_COUNT"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=pststenv\n");
    const { env } = loadEnv(TEST_NAME);
    assert.equal(env.WORKSPACES_ENABLED, "false");
    assert.equal(env.USER_POOL_MIN_COUNT, "1");
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=pststenv\nWORKSPACES_ENABLED=true\nUSER_POOL_MIN_COUNT=2\n");
    const loaded = loadEnv(TEST_NAME).env;
    assert.equal(loaded.WORKSPACES_ENABLED, "true");
    assert.equal(loaded.USER_POOL_MIN_COUNT, "2");
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    cleanup();
  }
});

test("a process variable sets the workspaces and node-pool keys over the file", () => {
  cleanup();
  const keys = ["WORKSPACES_ENABLED", "USER_POOL_MIN_COUNT"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=pststenv\nWORKSPACES_ENABLED=false\n");
    process.env.WORKSPACES_ENABLED = "true";
    process.env.USER_POOL_MIN_COUNT = "2";
    const { env } = loadEnv(TEST_NAME);
    assert.equal(env.WORKSPACES_ENABLED, "true");
    assert.equal(env.USER_POOL_MIN_COUNT, "2");
    process.env.WORKSPACES_ENABLED = "";
    process.env.USER_POOL_MIN_COUNT = "";
    const unset = loadEnv(TEST_NAME).env;
    assert.equal(unset.WORKSPACES_ENABLED, "false");
    assert.equal(unset.USER_POOL_MIN_COUNT, "1");
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    cleanup();
  }
});

test("PILOTSWARM_NATIVE_SUBAGENTS accepts only off or sync", () => {
  cleanup();
  const before = process.env.PILOTSWARM_NATIVE_SUBAGENTS;
  try {
    delete process.env.PILOTSWARM_NATIVE_SUBAGENTS;
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=pststenv\n");
    assert.equal(loadEnv(TEST_NAME).env.PILOTSWARM_NATIVE_SUBAGENTS, "off");
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=pststenv\nPILOTSWARM_NATIVE_SUBAGENTS= SYNC \n");
    assert.equal(loadEnv(TEST_NAME).env.PILOTSWARM_NATIVE_SUBAGENTS, "sync");
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=pststenv\n");
    process.env.PILOTSWARM_NATIVE_SUBAGENTS = "sync";
    assert.equal(loadEnv(TEST_NAME).env.PILOTSWARM_NATIVE_SUBAGENTS, "sync");
    process.env.PILOTSWARM_NATIVE_SUBAGENTS = "on";
    assert.throws(() => loadEnv(TEST_NAME), /PILOTSWARM_NATIVE_SUBAGENTS must be off or sync/);
  } finally {
    if (before === undefined) delete process.env.PILOTSWARM_NATIVE_SUBAGENTS;
    else process.env.PILOTSWARM_NATIVE_SUBAGENTS = before;
    cleanup();
  }
});

test("loadEnv overlays an external env file before process-env overrides", () => {
  cleanup();
  const overlayDir = mkdtempSync(join(tmpdir(), "pilotswarm-env-overlay-"));
  const overlayFile = join(overlayDir, "worker.env");
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(
      TEST_FILE,
      [
        "VALUE=local",
        "LOCAL_ONLY=local",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      overlayFile,
      [
        "VALUE=overlay",
        "OVERLAY_ONLY=overlay",
        "",
      ].join("\n"),
      "utf8",
    );

    const overlayArgument = relative(process.cwd(), overlayFile);
    const { env, sources } = loadEnv(TEST_NAME, {
      overlayEnvFile: overlayArgument,
      processEnv: {
        VALUE: "process",
        OVERLAY_ONLY: "process",
        UNRELATED: "ignored",
      },
    });

    assert.equal(env.VALUE, "process");
    assert.equal(env.LOCAL_ONLY, "local");
    assert.equal(env.OVERLAY_ONLY, "process");
    assert.equal(env.UNRELATED, undefined);
    assert.equal(sources.local, TEST_FILE);
    assert.equal(sources.overlay, resolve(overlayArgument));
  } finally {
    cleanup();
    rmSync(overlayDir, { recursive: true, force: true });
  }
});

test("loadEnv applies repeated external overlays in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "ps-overlay-order-"));
  const first = join(dir, "first.env");
  const second = join(dir, "second.env");
  writeFileSync(first, "ORDER=first\nFIRST_ONLY=yes\n");
  writeFileSync(second, "ORDER=second\nSECOND_ONLY=yes\n");
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=pststenv\n");
    const { env, sources } = loadEnv(TEST_NAME, {
      overlayEnvFiles: [first, second],
      processEnv: {},
    });
    assert.equal(env.ORDER, "second");
    assert.equal(env.FIRST_ONLY, "yes");
    assert.equal(env.SECOND_ONLY, "yes");
    assert.deepEqual(sources.overlays, [resolve(first), resolve(second)]);
    assert.equal(sources.overlay, resolve(second));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv rejects a missing external env file", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, "VALUE=local\n", "utf8");
    assert.throws(
      () => loadEnv(TEST_NAME, { overlayEnvFile: join(dirname(TEST_FILE), "missing.env") }),
      /External env file not found or not a file/,
    );
  } finally {
    cleanup();
  }
});

test("loadEnv composes a STAMP_ENV_FILE pointer as the base-most overlay", () => {
  cleanup();
  const dir = mkdtempSync(join(tmpdir(), "ps-stamp-env-"));
  const stampFile = join(dir, "pststenv.env");
  const cliOverlay = join(dir, "cli.env");
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    // Local stub: secrets/paths + pointer. Shared config lives in the stamp file.
    writeFileSync(
      TEST_FILE,
      [
        `STAMP_ENV_FILE=${stampFile}`,
        "GITHUB_TOKEN=local-secret",
        "SHARED=local",
        "",
      ].join("\n"),
      "utf8",
    );
    // Versioned stamp file wins over the local stub for shared config.
    writeFileSync(
      stampFile,
      ["SHARED=stamp", "STAMP_ONLY=stamp", "CLI_KEY=stamp", ""].join("\n"),
      "utf8",
    );
    // Explicit --env-overlay still wins over the stamp file.
    writeFileSync(cliOverlay, ["CLI_KEY=cli", ""].join("\n"), "utf8");

    const { env, sources } = loadEnv(TEST_NAME, {
      overlayEnvFiles: [cliOverlay],
      processEnv: {},
    });

    assert.equal(env.SHARED, "stamp"); // stamp file wins over local stub
    assert.equal(env.STAMP_ONLY, "stamp");
    assert.equal(env.GITHUB_TOKEN, "local-secret"); // stub-only key preserved
    assert.equal(env.CLI_KEY, "cli"); // explicit overlay wins over stamp file
    assert.equal(sources.stampEnvFile, resolve(stampFile));
    assert.deepEqual(sources.overlays, [resolve(stampFile), resolve(cliOverlay)]);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv lets process.env STAMP_ENV_FILE override the stub pointer", () => {
  cleanup();
  const dir = mkdtempSync(join(tmpdir(), "ps-stamp-env-proc-"));
  const stubStamp = join(dir, "stub.env");
  const procStamp = join(dir, "proc.env");
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, `STAMP_ENV_FILE=${stubStamp}\nSHARED=local\n`, "utf8");
    writeFileSync(stubStamp, "WHICH=stub\n", "utf8");
    writeFileSync(procStamp, "WHICH=proc\n", "utf8");

    const { env, sources } = loadEnv(TEST_NAME, {
      processEnv: { STAMP_ENV_FILE: procStamp },
    });

    assert.equal(env.WHICH, "proc");
    assert.equal(sources.stampEnvFile, resolve(procStamp));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv accepts process.env STAMP_ENV_FILE without a local stub", () => {
  cleanup();
  const dir = mkdtempSync(join(tmpdir(), "ps-stamp-env-direct-"));
  const stampFile = join(dir, "direct.env");
  try {
    writeFileSync(
      stampFile,
      [
        "RESOURCE_PREFIX=psdirect",
        "RESOURCE_GROUP=psdirect-wus2-rg",
        "STAMP_ONLY=direct",
        "",
      ].join("\n"),
      "utf8",
    );

    const { env, sources } = loadEnv(TEST_NAME, {
      processEnv: {
        STAMP_ENV_FILE: stampFile,
        ACME_EMAIL: "stamp-only@example.test",
        UNRECOGNIZED_AMBIENT_VALUE: "must-not-leak",
      },
    });

    assert.equal(env.RESOURCE_PREFIX, "psdirect");
    assert.equal(env.RESOURCE_GROUP, "psdirect-wus2-rg");
    assert.equal(env.STAMP_ONLY, "direct");
    assert.equal(env.ACME_EMAIL, "stamp-only@example.test");
    assert.equal(env.UNRECOGNIZED_AMBIENT_VALUE, undefined);
    assert.equal(sources.local, null);
    assert.equal(sources.stampEnvFile, resolve(stampFile));
    assert.deepEqual(sources.overlays, [resolve(stampFile)]);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv does not double-apply a STAMP_ENV_FILE also passed explicitly", () => {
  cleanup();
  const dir = mkdtempSync(join(tmpdir(), "ps-stamp-env-dedupe-"));
  const stampFile = join(dir, "stamp.env");
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, `STAMP_ENV_FILE=${stampFile}\n`, "utf8");
    writeFileSync(stampFile, "SHARED=stamp\n", "utf8");

    const { env, sources } = loadEnv(TEST_NAME, {
      overlayEnvFiles: [stampFile],
      processEnv: {},
    });

    assert.equal(env.SHARED, "stamp");
    assert.deepEqual(sources.overlays, [resolve(stampFile)]);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv rejects a missing STAMP_ENV_FILE pointer", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(
      TEST_FILE,
      `STAMP_ENV_FILE=${join(dirname(TEST_FILE), "missing-stamp.env")}\n`,
      "utf8",
    );
    assert.throws(() => loadEnv(TEST_NAME), /External env file not found or not a file/);
  } finally {
    cleanup();
  }
});

test("loadEnv() throws helpful message when local env is missing", () => {
  cleanup();
  assert.throws(
    () => loadEnv(TEST_NAME),
    new RegExp(`deploy:new-env -- ${TEST_NAME}`),
  );
});

test("loadEnv('foo') with invalid name throws name-validation error", () => {
  assert.throws(() => loadEnv("Foo"), /Invalid env name/);
  assert.throws(() => loadEnv("foo--bar"), /Invalid env name/);
});

test("loadEnv() rejects reserved env names", () => {
  for (const r of RESERVED_ENV_NAMES) {
    assert.throws(() => loadEnv(r), /reserved env name/);
  }
});

test("loadEnv expands ${STAMP_ENV_DIR} to the stamp env file's directory", () => {
  cleanup();
  const dir = mkdtempSync(join(tmpdir(), "ps-stamp-dir-"));
  const stampDir = join(dir, "stamps");
  const stampFile = join(stampDir, "the-stamp.env");
  try {
    mkdirSync(stampDir, { recursive: true });
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, `STAMP_ENV_FILE=${stampFile}\nSECRET=local\n`, "utf8");
    // The stamp repo injects a path anchored to its own directory.
    writeFileSync(
      stampFile,
      "WAF_CUSTOM_RULES_FILE=${STAMP_ENV_DIR}/waf/rules.json\n",
      "utf8",
    );

    const { env } = loadEnv(TEST_NAME, { processEnv: {} });

    // Token expands to the stamp dir; the suffix keeps its literal separators
    // (mixed separators resolve fine downstream). Compare normalized.
    assert.equal(
      resolve(env.WAF_CUSTOM_RULES_FILE),
      resolve(join(stampDir, "waf", "rules.json")),
    );
    assert.equal(env.SECRET, "local"); // untokenized values untouched
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv throws when ${STAMP_ENV_DIR} is used without a stamp env file", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    // Token used in the local stub itself, with no STAMP_ENV_FILE pointer.
    writeFileSync(
      TEST_FILE,
      "WAF_CUSTOM_RULES_FILE=${STAMP_ENV_DIR}/waf/rules.json\n",
      "utf8",
    );
    assert.throws(
      () => loadEnv(TEST_NAME, { processEnv: {} }),
      /uses \$\{STAMP_ENV_DIR\} but no stamp env file is in play/,
    );
  } finally {
    cleanup();
  }
});

test("expandStampEnvDir replaces every occurrence and leaves other values intact", () => {
  const env = {
    A: `${STAMP_ENV_DIR_TOKEN}/one/${STAMP_ENV_DIR_TOKEN}/two`,
    B: "plain",
    C: 123, // non-string values are skipped, not coerced
  };
  expandStampEnvDir(env, join("/base", "stamp.env"));
  assert.equal(env.A, join("/base") + "/one/" + join("/base") + "/two");
  assert.equal(env.B, "plain");
  assert.equal(env.C, 123);
});

test("expandStampEnvDir throws when token used but stampEnvFile is null", () => {
  assert.throws(
    () => expandStampEnvDir({ X: `${STAMP_ENV_DIR_TOKEN}/f.json` }, null),
    /uses \$\{STAMP_ENV_DIR\} but no stamp env file is in play/,
  );
});

for (const blankUrlKeys of [false, true]) {
  test(`provisioned env ignores ambient URLs (${blankUrlKeys ? "blank file keys" : "absent file keys"})`, (t) => {
    cleanup();
    const keys = ["DEPLOY_POSTGRES", ...DATABASE_URL_KEYS];
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
      cleanup();
    });
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, [
      "RESOURCE_PREFIX=pststenv",
      ...(blankUrlKeys ? DATABASE_URL_KEYS.map((key) => `${key}=`) : []),
      "",
    ].join("\n"));
    process.env.DEPLOY_POSTGRES = "true";
    for (const key of DATABASE_URL_KEYS) process.env[key] = "******external.invalid/app";
    const { env } = loadEnv(TEST_NAME);
    for (const key of DATABASE_URL_KEYS) {
      assert.equal(env[key], blankUrlKeys ? "" : undefined);
    }
    Object.assign(env, {
      POSTGRES_FQDN: "stamp.invalid",
      POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "stamp-uami",
      PILOTSWARM_USE_MANAGED_IDENTITY: "1",
    });
    composeDerivedEnv(env);
    for (const key of DATABASE_URL_KEYS) {
      assert.equal(new URL(env[key]).hostname, "stamp.invalid");
    }
  });
}

test("provisioned env preserves explicit file URLs instead of ambient overrides", (t) => {
  cleanup();
  const keys = ["DEPLOY_POSTGRES", ...DATABASE_URL_KEYS];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    cleanup();
  });
  const fileUrl = "postgresql://file-user@file-host.invalid/app";
  mkdirSync(dirname(TEST_FILE), { recursive: true });
  writeFileSync(TEST_FILE, DATABASE_URL_KEYS.map((key) => `${key}=${fileUrl}`).join("\n"));
  process.env.DEPLOY_POSTGRES = "true";
  for (const key of DATABASE_URL_KEYS) process.env[key] = "******external.invalid/app";
  const { env } = loadEnv(TEST_NAME);
  for (const key of DATABASE_URL_KEYS) assert.equal(env[key], fileUrl);
});
