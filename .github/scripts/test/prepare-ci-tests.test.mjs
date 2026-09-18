import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
test('all database variable conventions resolve to the disposable CI PostgreSQL service', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ps-ci-config-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../prepare-ci-tests.mjs', import.meta.url))], {
    cwd, encoding: 'utf8', env: { ...process.env, CI_TEST_ENV_JSON: JSON.stringify({ GITHUB_TOKEN: 'test-token', PS_TEST_DATABASE_URL: 'postgresql://example.invalid/old' }), MODEL_PROVIDERS_JSON: JSON.stringify({ providers: [{ id: 'test' }] }) },
  });
  assert.equal(result.status, 0, result.stderr);
  const env = parseEnv(readFileSync(join(cwd, '.env'), 'utf8'));
  assert.equal(env.DATABASE_URL, 'postgresql://postgres:postgres@localhost:5432/durable_copilot');
  assert.equal(env.PS_TEST_DATABASE_URL, env.DATABASE_URL);
  assert.equal(env.TEST_DATABASE_URL, env.DATABASE_URL);
});
