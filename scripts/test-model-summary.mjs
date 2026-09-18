import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Show only model identifiers, never credentials, endpoints or provider metadata.
const path = process.env.PS_MODEL_PROVIDERS_PATH || process.env.MODEL_PROVIDERS_PATH
  || resolve('packages/sdk/test/fixtures/model-providers.test.json');
const catalog = JSON.parse(readFileSync(path, 'utf8'));
console.log(`SDK test default model: ${catalog.defaultModel}`);
for (const p of catalog.providers) {
  console.log(`Configured test models (${p.type}): ${p.models.map(m => `${p.id}:${typeof m === 'string' ? m : m.name}`).join(', ')}`);
}
console.log('Configured models are not a live-call matrix; individual suites select models. Synthetic compatibility tests use mock endpoints.');
if (process.env.HORIZON_EMBED_MODEL) {
  console.log(`HorizonDB embedding model: ${process.env.HORIZON_EMBED_MODEL} (rotation also uses its -v2 deployment alias).`);
}
