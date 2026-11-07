/**
 * Smoke tests for the CLI entry point.
 *
 * Runs the binary the way a user would, so the package wiring (bin path, ESM, version) is
 * exercised rather than any one module.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const bin = fileURLToPath(new URL('../bin/buwp-cloud.js', import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

/**
 * Run the CLI with the given arguments.
 * @param {...string} args - Arguments passed after the binary
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function run(...args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

test('--version prints the package version and exits 0', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
});

test('--help exits 0 and writes nothing to stderr', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: buwp-cloud/);
  assert.equal(result.stderr, '');
});

test('no arguments prints help and exits 0', () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: buwp-cloud/);
});
