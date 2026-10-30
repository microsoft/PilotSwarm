import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';

function yamlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? yamlFiles(path) : /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

function pinnedUses(text, file) {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { version: '1.2', uniqueKeys: true, keepSourceTokens: true, lineCounter });
  assert.equal(document.errors.length, 0, `${file}: ${document.errors.map(error => error.message).join('\n')}`);
  const references = [];
  const resolve = node => isAlias(node) ? node.resolve(document) : node;
  const line = node => lineCounter.linePos(node.range[1]).line;
  const mapping = node => {
    const map = resolve(node);
    assert(isMap(map), `${file}: expected a YAML mapping`);
    for (const { key } of map.items) {
      assert(isScalar(key) && typeof key.value === 'string', `${file}: mapping keys must be strings`);
      assert.notEqual(key.value, '<<', `${file}: YAML merge keys are not supported by GitHub Actions`);
    }
    return map;
  };
  const inlineComment = node => {
    const comment = node.srcToken?.end?.find(token => token.type === 'comment');
    return comment && lineCounter.linePos(comment.offset).line === line(node) ? comment.source.slice(1).trim() : '';
  };
  const inspectUses = map => {
    if (!map.has('uses')) return;
    const source = map.get('uses', true);
    const scalar = resolve(source);
    assert(isScalar(scalar) && typeof scalar.value === 'string', `${file}: uses must be a string`);
    const reference = scalar.value;
    if (reference.startsWith('./')) return;
    const location = `${file}:${lineCounter.linePos(source.range[0]).line}`;
    assert.match(reference, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
      `${location}: remote uses must have a full lowercase commit SHA`);
    const comment = inlineComment(source) || inlineComment(scalar)
      || (map.flow && line(source) === line(map) ? inlineComment(map) : '');
    assert.match(comment, /^v\d+\.\d+\.\d+$/,
      `${location}: remote uses must have a full version comment`);
    references.push(reference);
  };
  const inspectSteps = owner => {
    if (!owner.has('steps')) return;
    const steps = resolve(owner.get('steps', true));
    assert(isSeq(steps), `${file}: steps must be a YAML sequence`);
    for (const step of steps.items) inspectUses(mapping(step));
  };
  const root = mapping(document.contents);
  if (root.has('jobs')) {
    for (const { value } of mapping(root.get('jobs', true)).items) {
      const job = mapping(value);
      inspectUses(job);
      inspectSteps(job);
    }
  }
  if (root.has('runs')) {
    const runs = mapping(root.get('runs', true));
    if (resolve(runs.get('using', true))?.value === 'composite') inspectSteps(runs);
  }
  return references;
}

function workflow(steps) {
  return `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps.split('\n').map(line => `      ${line}`).join('\n')}\n`;
}

test('action pins allow new immutable revisions, quoted scalars and local actions', () => {
  const sha = 'a'.repeat(40);
  const references = pinnedUses(workflow([
    `- uses: example/action@${sha} # v2.3.4`,
    `- uses: "example/action@${'b'.repeat(40)}" # v3.0.0`,
    `- { name: "checkout #1", uses: 'example/action@${sha}' } # v1.2.3`,
    '- uses: ./.github/actions/deploy-azure',
    '- uses: "./.github/actions/provider-tests"',
    '- uses: \'./.github/actions/example\' # local action',
  ].join('\n')).replaceAll('\n', '\r\n'), 'fixture.yml');
  assert.deepEqual(references, [`example/action@${sha}`, `example/action@${'b'.repeat(40)}`, `example/action@${sha}`]);
});

test('action pins reject tags, branches, invalid SHAs and missing full version comments', () => {
  const sha = 'a'.repeat(40);
  for (const reference of ['v4', 'main', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40)]) {
    assert.throws(() => pinnedUses(workflow(`- uses: example/action@${reference} # v1.2.3`), 'fixture.yml'),
      /full lowercase commit SHA/);
  }
  for (const comment of ['', '# v1', '# v1.2', '# latest']) {
    assert.throws(() => pinnedUses(workflow(`- uses: example/action@${sha} ${comment}`), 'fixture.yml'),
      /full version comment/);
  }
});

test('parsed uses keys reject mutable references in flow maps and alternate YAML key forms', () => {
  for (const step of [
    '- uses: actions/checkout@v5',
    '- { name: "checkout #1", uses: actions/checkout@v5 }',
    '- "uses": actions/checkout@v5',
    '- \'uses\': actions/checkout@v5',
    '- "u\\u0073es": actions/checkout@v5',
    '- { "\\u0075ses": actions/checkout@v5 }',
    '- ? uses\n  : actions/checkout@v5',
    '- ? "u\\u0073es"\n  : actions/checkout@v5',
    '- !!str uses: actions/checkout@v5',
    '- uses: >-\n    actions/checkout@v5',
  ]) {
    assert.throws(() => pinnedUses(workflow(step), 'fixture.yml'), /full lowercase commit SHA/, step);
  }
});

test('script text and unrelated mappings are not action calls or version comments', () => {
  assert.deepEqual(pinnedUses(workflow([
    '- name: \'uses: actions/checkout@v5\'',
    '  env: { uses: actions/checkout@v5 }',
    '  run: |',
    '    echo "uses: actions/checkout@v5"',
    '    echo \'? "u\\u0073es": actions/checkout@v5\'',
  ].join('\n')), 'fixture.yml'), []);
  const sha = 'a'.repeat(40);
  assert.throws(() => pinnedUses(workflow(`- { name: "# v1.2.3", uses: example/action@${sha} }`), 'fixture.yml'),
    /full version comment/);
  assert.throws(() => pinnedUses(workflow(`- name: Checkout # v1.2.3\n  uses: example/action@${sha}`), 'fixture.yml'),
    /full version comment/);
});

test('job-level reusable workflows and composite steps are validated', () => {
  const sha = 'a'.repeat(40);
  const reusable = `jobs:\n  build:\n    uses: example/repo/.github/workflows/build.yml@${sha} # v1.2.3\n`;
  assert.deepEqual(pinnedUses(reusable, 'fixture.yml'), [`example/repo/.github/workflows/build.yml@${sha}`]);
  assert.throws(() => pinnedUses(reusable.replace(sha, 'v1'), 'fixture.yml'), /full lowercase commit SHA/);
  const composite = `runs:\n  using: composite\n  steps:\n    - uses: example/action@${sha} # v1.2.3\n    - uses: ./.github/actions/local\n`;
  assert.deepEqual(pinnedUses(composite, 'action.yml'), [`example/action@${sha}`]);
  assert.throws(() => pinnedUses(composite.replace(sha, 'v1'), 'action.yml'), /full lowercase commit SHA/);
});

test('aliases cannot hide mutable calls and invalid or unsupported mappings fail closed', () => {
  const sha = 'a'.repeat(40);
  const steps = `- &checkout\n  uses: example/action@${sha} # v1.2.3\n- *checkout`;
  assert.deepEqual(pinnedUses(workflow(steps), 'fixture.yml'), [`example/action@${sha}`, `example/action@${sha}`]);
  assert.throws(() => pinnedUses(workflow(steps.replace(sha, 'v1')), 'fixture.yml'), /full lowercase commit SHA/);
  const scalarAlias = `- uses: &ref example/action@${sha} # v1.2.3\n- uses: *ref`;
  assert.deepEqual(pinnedUses(workflow(scalarAlias), 'fixture.yml'), [`example/action@${sha}`, `example/action@${sha}`]);
  assert.throws(() => pinnedUses(workflow(scalarAlias.replace(sha, 'v1')), 'fixture.yml'), /full lowercase commit SHA/);
  assert.throws(() => pinnedUses(workflow('- uses: one\n  uses: two'), 'fixture.yml'), /keys must be unique/);
  assert.throws(() => pinnedUses(workflow('- { uses: [broken }'), 'fixture.yml'));
  assert.throws(() => pinnedUses(workflow('- &defaults { uses: ./.github/actions/local }\n- <<: *defaults'), 'fixture.yml'),
    /merge keys are not supported/);
});

test('workflow and composite action references are versioned SHA pins with consistent Azure login revisions', () => {
  const github = fileURLToPath(new URL('../..', import.meta.url));
  const files = ['workflows', 'actions'].flatMap(directory => yamlFiles(join(github, directory)));
  const references = files.flatMap(file => pinnedUses(readFileSync(file, 'utf8'), file));
  assert(references.length > 0, 'No remote action references were scanned');
  const loginPins = references.filter(reference => reference.startsWith('azure/login@'));
  assert(loginPins.length > 0, 'No Azure login references were scanned');
  assert.equal(new Set(loginPins).size, 1, 'All Azure login uses must resolve to the same revision');
});
