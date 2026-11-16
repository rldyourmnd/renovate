import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [image, output] = process.argv.slice(2);
assert.ok(image && output, 'usage: qualify-alias-runtime.mjs IMAGE OUTPUT');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const repository = 'NDDev-Technocracy-OpenNetwork/nddev-ci';
const revision = '3e5aabcba0485ac98679a050e0a99793ddf7c72b';
const files = [
  [
    'lib/renovate-sdk.mjs',
    'definition.mjs',
    '7eed792022674b24cdba2a049fc8b8eabd8ee9902b839fdd1a09eef39d1a2486',
  ],
  [
    'renovate-sdk-inputs.json',
    'preset.json',
    '3452492985aa7155747a8ce09cb7dd582cc53a3bae46fe2022d993b1187c6027',
  ],
  [
    'renovate.json',
    'self.json',
    '4e2a584b02ab05b1078a6584a473045a0aa719c40a984f7e3696ee4a3234cf9b',
  ],
  [
    'tests/fixtures/renovate/qualify.mjs',
    'qualify.mjs',
    '8fc65cb31bb8a88f67ed3e58cbd6d2446b29c18123e334911ce5d2294f35c306',
  ],
];
const expectedFailures = [
  'an aliased version shared with a foreign call is not silently rewritten',
  'relative owned alias stays unchanged or is refused',
  'qualified foreign alias stays unchanged or is refused',
  'relative foreign alias stays unchanged or is refused',
  'autoReplaceGlobalMatch false: owned alias stays unchanged or is refused',
  'autoReplaceGlobalMatch false: foreign alias stays unchanged or is refused',
].sort();
const directory = mkdtempSync(path.join(tmpdir(), 'renovate-alias-runtime-'));
const containers = [];
const report = {
  image,
  version,
  fixture: { repository, revision, files },
  modes: [],
  cleanup: false,
};
mkdirSync(output, { recursive: true });
chmodSync(directory, 0o755);

/** @param {string} text @returns {string} */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** @param {string[]} args @returns {import('node:child_process').SpawnSyncReturns<string>} */
function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}

/** @param {string} name @param {string} contents @returns {void} */
function fixtureFile(name, contents) {
  const target = path.join(directory, name);
  writeFileSync(target, contents);
  chmodSync(target, 0o644);
}

/** @param {string[]} command @returns {import('node:child_process').SpawnSyncReturns<string>} */
function runImage(command) {
  const name = `renovate-alias-${randomUUID()}`;
  containers.push(name);
  return docker([
    'run',
    '--rm',
    '--name',
    name,
    '--read-only',
    '--user',
    '12021:12021',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--tmpfs',
    '/tmp:rw,size=64m,mode=1777',
    '--memory',
    '1g',
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    '--mount',
    `type=bind,src=${directory},dst=/fixture,readonly`,
    '--entrypoint',
    '/usr/local/renovate/node',
    image,
    ...command,
  ]);
}

try {
  for (const [source, destination, digest] of files) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${repository}/${revision}/${source}`,
      {
        signal: AbortSignal.timeout(30000),
      },
    );
    assert.ok(
      response.ok,
      `public fixture fetch failed: ${response.status} ${source}`,
    );
    const contents = await response.text();
    assert.equal(
      sha256(contents),
      digest,
      `public fixture identity: ${source}`,
    );
    fixtureFile(destination, contents);
  }
  fixtureFile(
    'source.json',
    JSON.stringify({
      repository,
      revision,
      version,
      presetSha256: files[1][2],
    }),
  );
  const cli = runImage(['/usr/local/renovate/dist/renovate.js', '--version']);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(cli.stdout.trim(), version);
  report.cliVersion = cli.stdout.trim();

  const original = readFileSync(path.join(directory, 'qualify.mjs'), 'utf8');
  for (const strict of [false, true]) {
    const mode = strict ? 'synthetic-strict' : 'unchanged-public-preset';
    if (strict) {
      // Only the local fixture configuration changes. The query, mappings, loader and all assertions stay intact.
      const marker = 'const fq = ';
      assert.equal(original.split(marker).length, 2);
      const guard = `for (const config of [consumer, self, localPreset]) {\n  config.customManagers = config.customManagers.map((manager) => ({ ...manager, yamlMaxAliasCount: 0 }));\n}\n`;
      fixtureFile('qualify.mjs', original.replace(marker, `${guard}${marker}`));
      const preset = JSON.parse(
        readFileSync(path.join(directory, 'preset.json'), 'utf8'),
      );
      preset.customManagers = preset.customManagers.map((manager) => ({
        ...manager,
        yamlMaxAliasCount: 0,
      }));
      fixtureFile('synthetic-strict.json', JSON.stringify(preset));
      const validation = runImage([
        '/usr/local/renovate/dist/config-validator.js',
        '/fixture/synthetic-strict.json',
      ]);
      writeFileSync(
        path.join(output, 'config-validation.log'),
        validation.stdout + validation.stderr,
      );
      assert.equal(validation.status, 0, validation.stdout + validation.stderr);
      report.configValidation = 'passed';
    }
    const result = runImage([
      '--test',
      '--test-reporter=tap',
      '/fixture/qualify.mjs',
    ]);
    const log = result.stdout + result.stderr;
    writeFileSync(path.join(output, `${mode}.tap`), log);
    const lines = result.stdout.split('\n');
    const counts = {};
    for (const key of [
      'tests',
      'pass',
      'fail',
      'cancelled',
      'skipped',
      'todo',
    ]) {
      const line = lines.find((value) => value.startsWith(`# ${key} `));
      assert.ok(line, `missing TAP count ${key}: ${mode}`);
      counts[key] = Number(line.slice(`# ${key} `.length));
    }
    const failures = lines
      .filter((line) => line.startsWith('not ok '))
      .map((line) => line.slice(line.indexOf(' - ') + 3))
      .sort();
    const observation = {
      mode,
      status: result.status,
      counts,
      failures,
      fixtureSha256: sha256(
        readFileSync(path.join(directory, 'qualify.mjs'), 'utf8'),
      ),
    };
    report.modes.push(observation);
    process.stdout.write(`${JSON.stringify(observation)}\n`);
    assert.deepEqual(
      counts,
      {
        tests: 33,
        pass: strict ? 33 : 27,
        fail: strict ? 0 : 6,
        cancelled: 0,
        skipped: 0,
        todo: 0,
      },
      log,
    );
    assert.deepEqual(failures, strict ? [] : expectedFailures);
    assert.equal(result.status, strict ? 0 : 1, log);
  }
} finally {
  const cleanupErrors = [];
  for (const name of containers) {
    const removed = docker(['rm', '--force', name]);
    if (removed.status !== 0 && !removed.stderr.includes('No such container')) {
      cleanupErrors.push(removed.stderr);
    }
  }
  rmSync(directory, { recursive: true, force: true });
  report.cleanup = cleanupErrors.length === 0;
  writeFileSync(
    path.join(output, 'qualification.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  assert.deepEqual(cleanupErrors, [], 'owned container cleanup failed');
}
