import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDatabase, runnerResources } from '../ci-health.mjs';

function clientFixture({ failureAt, code } = {}) {
  const state = { ended: false };
  class Client {
    constructor(options) {
      state.options = options;
    }
    on() {}
    async connect() {
      if (failureAt === 'connect') throw Object.assign(new Error('secret connection URL'), { code });
    }
    async query(sql) {
      state.sql = sql;
      if (failureAt === 'query') throw Object.assign(new Error('secret query detail'), { code });
      return { rows: [{ connections: 123, max_connections: 1500 }] };
    }
    async end() {
      state.ended = true;
      if (failureAt === 'end') throw new Error('secret cleanup detail');
    }
  }
  return { Client, state };
}

test('health probes use fresh bounded connections, report aggregates and close them', async () => {
  const { Client, state } = clientFixture();
  const result = await probeDatabase('postgresql://example.invalid/test', Client);
  assert.equal(result.ok, true);
  assert.equal(result.connections, 123);
  assert.equal(result.maxConnections, 1500);
  assert.equal(typeof result.connectMs, 'number');
  assert.equal(typeof result.queryMs, 'number');
  assert.equal(state.options.connectionTimeoutMillis, 10_000);
  assert.equal(state.options.query_timeout, 10_000);
  assert.match(state.sql, /^SELECT /);
  assert.equal(state.ended, true);
});

for (const failureAt of ['connect', 'query', 'end']) {
  test(`health probes report ${failureAt} failures without leaking error messages`, async () => {
    const { Client, state } = clientFixture({ failureAt, code: 'ECONNRESET' });
    const result = await probeDatabase('postgresql://example.invalid/test', Client);
    assert.equal(result.ok, false);
    assert.equal(state.ended, true);
    assert.doesNotMatch(JSON.stringify(result), /secret|example\.invalid/);
    if (failureAt !== 'end') {
      assert.equal(result.stage, failureAt);
      assert.equal(result.code, 'ECONNRESET');
    } else assert.equal(result.cleanupError, 'CONNECTION_FAILED');
  });
}

test('untrusted error codes are not logged', async () => {
  const { Client } = clientFixture({ failureAt: 'connect', code: 'https://secret.invalid' });
  assert.equal((await probeDatabase('unused', Client)).code, 'CONNECTION_FAILED');
});

test('runner diagnostics report numeric capacity without machine identity', () => {
  const result = runnerResources('MemAvailable:   2048000 kB\nSwapFree: 1024000 kB\n');
  assert.equal(result.availableMB, 2000);
  assert.equal(result.swapFreeMB, 1000);
  assert(result.cpus > 0);
  assert.equal(result.load.length, 3);
  assert.throws(() => runnerResources(''), /Missing runner memory counter/);
});
