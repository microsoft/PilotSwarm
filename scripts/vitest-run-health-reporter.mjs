import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export function executionIdentity(env) {
  const keys = Object.keys(env).filter(key => env[key] != null &&
    /^(DATABASE_URL|PLAIN_DATABASE_URL|PS_TEST_DATABASE_URL|TEST_DATABASE_URL|HORIZON_|PILOTSWARM_RUNTIME_|PILOTSWARM_DUROXIDE_|PILOTSWARM_CMS_FACTS_DATABASE_URL|PILOTSWARM_SESSION_CATALOG_URL|PILOTSWARM_FACTSTORE_URL|PILOTSWARM_GRAPH_|PS_MODEL_PROVIDERS_PATH|GITHUB_TOKEN$)/.test(key)).sort();
  return {
    sourceSha: env.GITHUB_SHA || null,
    environmentHash: createHash('sha256').update(JSON.stringify(keys.map(key => [key, String(env[key])]))).digest('hex'),
  };
}

export default class RunHealthReporter {
  onTestRunEnd(_modules, errors, reason) {
    const file = process.env.PILOTSWARM_TEST_HEALTH_FILE;
    if (!file) throw new Error('PILOTSWARM_TEST_HEALTH_FILE is required for run-health reporting.');
    writeFileSync(file, JSON.stringify({
      ...executionIdentity(process.env), unhandledErrors: errors.length, reason,
    }), { mode: 0o600 });
  }
}
