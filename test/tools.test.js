/**
 * Tests for checking the local session tools.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, checkTools, TESTED_PLUGIN_VERSION } from '../lib/index.js';

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

describe('compareVersions', () => {
  test('compares each part as a number', () => {
    assert.ok(compareVersions('1.2.553.0', '1.2.98.0') > 0);
    assert.ok(compareVersions('1.2.98.0', TESTED_PLUGIN_VERSION) < 0);
    assert.equal(compareVersions('2.36', '2.36.0'), 0);
  });
});

describe('checkTools', () => {
  test('reads both versions', () => {
    const outputs = {
      aws: { stdout: 'aws-cli/2.36.40 Python/3.14.7 Darwin/24.6.0 source/arm64\n' },
      'session-manager-plugin': { stdout: '1.2.553.0\n' },
    };
    const [aws, plugin] = checkTools({ run: (cmd) => outputs[cmd] });

    assert.deepEqual(aws, { name: 'aws', found: true, version: '2.36.40', problem: null, belowTested: false });
    assert.deepEqual(plugin, { name: 'session-manager-plugin', found: true, version: '1.2.553.0', problem: null, belowTested: false });
  });

  test('a missing tool is not found, and an older plugin is flagged', () => {
    const outputs = {
      aws: { error: enoent() },
      'session-manager-plugin': { stdout: '1.2.98.0\n' },
    };
    const [aws, plugin] = checkTools({ run: (cmd) => outputs[cmd] });

    assert.equal(aws.found, false);
    assert.equal(aws.problem, null);
    assert.equal(plugin.belowTested, true);
  });
});
