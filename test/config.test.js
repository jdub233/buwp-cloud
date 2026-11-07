/**
 * Tests for the per-user config file and profile resolution.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configPath, loadConfig, resolveProfiles, CONFIG_ENV_VAR } from '../lib/index.js';

const tempDirs = [];

/**
 * Write a config file into a throwaway directory.
 * @param {string} contents - Raw file contents
 * @returns {NodeJS.ProcessEnv} An env pointing loadConfig at the file
 */
function envWithConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buwp-cloud-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, contents);
  return { [CONFIG_ENV_VAR]: file };
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('configPath', () => {
  test('an explicit BUWP_CLOUD_CONFIG wins', () => {
    assert.equal(configPath({ [CONFIG_ENV_VAR]: '/x/c.json', XDG_CONFIG_HOME: '/xdg' }), '/x/c.json');
  });

  test('uses XDG_CONFIG_HOME when set', () => {
    assert.equal(configPath({ XDG_CONFIG_HOME: '/xdg' }), path.join('/xdg', 'buwp-cloud', 'config.json'));
  });

  test('falls back to ~/.config', () => {
    assert.equal(configPath({}), path.join(os.homedir(), '.config', 'buwp-cloud', 'config.json'));
  });
});

describe('loadConfig', () => {
  test('a missing file means no config', () => {
    assert.deepEqual(loadConfig({ [CONFIG_ENV_VAR]: path.join(os.tmpdir(), 'buwp-cloud-no-such-file.json') }), {});
  });

  test('reads profiles', () => {
    const env = envWithConfig(JSON.stringify({ profiles: ['example-nprd', 'example-prd'] }));
    assert.deepEqual(loadConfig(env), { profiles: ['example-nprd', 'example-prd'] });
  });

  test('invalid JSON names the file', () => {
    const env = envWithConfig('{ not json');
    assert.throws(() => loadConfig(env), new RegExp(`Invalid JSON in ${env[CONFIG_ENV_VAR]}`));
  });

  test('rejects a non-object and a malformed profiles list', () => {
    assert.throws(() => loadConfig(envWithConfig('[]')), /must contain a JSON object/);
    assert.throws(() => loadConfig(envWithConfig('{"profiles": "example-nprd"}')), /must be an array/);
    assert.throws(() => loadConfig(envWithConfig('{"profiles": ["ok", ""]}')), /must be an array/);
  });
});

describe('resolveProfiles', () => {
  test('--profile flags win over the config file', () => {
    assert.deepEqual(resolveProfiles(['a'], { profiles: ['b'] }), ['a']);
  });

  test('the config file is used when there are no flags', () => {
    assert.deepEqual(resolveProfiles([], { profiles: ['b', 'c'] }), ['b', 'c']);
  });

  test('with neither, the default credential chain is searched', () => {
    assert.deepEqual(resolveProfiles([], {}), [null]);
    assert.deepEqual(resolveProfiles(), [null]);
  });

  test('duplicates are dropped', () => {
    assert.deepEqual(resolveProfiles(['a', 'a', 'b']), ['a', 'b']);
  });
});
