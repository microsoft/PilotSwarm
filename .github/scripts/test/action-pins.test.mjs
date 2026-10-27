import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function yamlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? yamlFiles(path) : /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

function pinnedUses(text, file) {
  const references = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const location = `${file}:${index + 1}`;
    const uses = line.match(/^[ \t]*(?:-[ \t]+)?(?:uses|"uses"|'uses'):[ \t]*(.*)$/);
    if (!uses) {
      assert(!/^[^#]*\buses["']?[ \t]*:/.test(line),
        `${location}: uses must be a single-line block-style action reference`);
      continue;
    }
    const scalar = uses[1].match(/^(?:"([^"]+)"|'([^']+)'|([^#\s]+))[ \t]*(?:#[ \t]*(.*))?$/);
    assert(scalar, `${location}: uses must be a single-line action reference`);
    const reference = scalar[1] ?? scalar[2] ?? scalar[3];
    if (reference.startsWith('./')) continue;
    assert.match(reference, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
      `${location}: remote uses must have a full lowercase commit SHA`);
    assert.match(scalar[4] ?? '', /^v\d+\.\d+\.\d+[ \t]*$/,
      `${location}: remote uses must have a full version comment`);
    references.push(reference);
  }
  return references;
}

test('action pins allow new immutable revisions, quoted scalars and local actions', () => {
  const sha = 'a'.repeat(40);
  const references = pinnedUses([
    `      - uses: example/action@${sha} # v2.3.4`,
    `        uses: "example/action@${'b'.repeat(40)}" # v3.0.0`,
    `        uses: 'example/repo/.github/workflows/build.yml@${sha}' # v1.2.3`,
    '      - uses: ./.github/actions/deploy-azure',
    '      - uses: "./.github/actions/provider-tests"',
    '      - uses: \'./.github/actions/example\' # local action',
  ].join('\r\n'), 'fixture.yml');
  assert.equal(references.length, 3);
});

test('action pins reject tags, branches, invalid SHAs and missing full version comments', () => {
  const sha = 'a'.repeat(40);
  for (const reference of ['v4', 'main', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40)]) {
    assert.throws(() => pinnedUses(`- uses: example/action@${reference} # v1.2.3`, 'fixture.yml'),
      /full lowercase commit SHA/);
  }
  for (const comment of ['', '# v1', '# v1.2', '# latest']) {
    assert.throws(() => pinnedUses(`- uses: example/action@${sha} ${comment}`, 'fixture.yml'),
      /full version comment/);
  }
  assert.throws(() => pinnedUses('- uses:\n    example/action@v1', 'fixture.yml'),
    /single-line action reference/);
  assert.throws(() => pinnedUses('- { uses: example/action@v1 }', 'fixture.yml'),
    /single-line block-style action reference/);
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
