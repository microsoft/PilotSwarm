import { writeFileSync } from 'node:fs';
const env = JSON.parse(process.env.CI_TEST_ENV_JSON || '{}');
if (!env.GITHUB_TOKEN) throw new Error('CI_TEST_ENV_JSON requires a Copilot-enabled GITHUB_TOKEN.');
env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/durable_copilot';
env.PS_TEST_DATABASE_URL = env.DATABASE_URL;
env.TEST_DATABASE_URL = env.DATABASE_URL;
env.PS_TEST_SKIP_STALE_CLEANUP = '1';
const lines = Object.entries(env).map(([key, value]) => {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n"']/.test(value)) throw new Error('Invalid CI environment value.');
  if (value.length >= 4) console.log(`::add-mask::${value.replaceAll('%', '%25')}`);
  return `${key}="${value}"`;
});
const providers = JSON.parse(process.env.MODEL_PROVIDERS_JSON || '{}');
if (!providers.providers?.length) throw new Error('MODEL_PROVIDERS_JSON requires a provider catalog.');
for (const p of providers.providers) {
  if (p.baseUrl) {
    console.log(`::add-mask::${p.baseUrl}`);
    console.log(`::add-mask::${new URL(p.baseUrl).hostname}`);
  }
}
writeFileSync('.env', lines.join('\n'), { mode: 0o600 });
writeFileSync('.model_providers.json', JSON.stringify(providers), { mode: 0o600 });
