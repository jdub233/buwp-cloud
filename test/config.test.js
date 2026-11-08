/**
 * Tests for config file lookup, loading and profile resolution.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CONFIG_FILE_NAME,
  OVERRIDE_FILE_NAME,
  CONFIG_ENV_VAR,
  findConfigDir,
  findConfigFiles,
  loadConfig,
  resolveProfiles,
} from '../lib/index.js';

const tempDirs = [];

/**
 * Build a directory tree in a throwaway location.
 * @param {Record<string, string|object>} files - Relative path to contents; objects become JSON
 * @returns {string} The tree's root
 */
function makeTree(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buwp-cloud-test-'));
  tempDirs.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return root;
}

/** Make a directory inside a tree and return its path. */
function subdir(root, rel) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('findConfigDir', () => {
  test('finds the config in the current directory', () => {
    const root = makeTree({ [CONFIG_FILE_NAME]: { profiles: ['a'] } });
    assert.equal(findConfigDir(root), root);
  });

  test('walks up from a subdirectory', () => {
    const root = makeTree({ [CONFIG_FILE_NAME]: { profiles: ['a'] } });
    assert.equal(findConfigDir(subdir(root, 'x/y')), root);
  });

  test('the nearest directory wins', () => {
    const root = makeTree({
      [CONFIG_FILE_NAME]: { profiles: ['outer'] },
      [`inner/${CONFIG_FILE_NAME}`]: { profiles: ['inner'] },
    });
    assert.equal(findConfigDir(subdir(root, 'inner/deeper')), path.join(root, 'inner'));
  });

  test('an override file alone marks the directory too', () => {
    const root = makeTree({ [OVERRIDE_FILE_NAME]: { profiles: ['a'] } });
    assert.equal(findConfigDir(subdir(root, 'x')), root);
  });
});

describe('findConfigFiles and loadConfig', () => {
  test('no config anywhere means an empty config and no files', () => {
    const root = makeTree();
    assert.deepEqual(loadConfig({ env: {}, cwd: root }), { config: {}, files: [] });
  });

  test('reads the config file', () => {
    const root = makeTree({ [CONFIG_FILE_NAME]: { profiles: ['a', 'b'] } });
    assert.deepEqual(loadConfig({ env: {}, cwd: root }), {
      config: { profiles: ['a', 'b'] },
      files: [path.join(root, CONFIG_FILE_NAME)],
    });
  });

  test('the override file is merged over the config file', () => {
    const root = makeTree({
      [CONFIG_FILE_NAME]: { profiles: ['shared'], other: 1 },
      [OVERRIDE_FILE_NAME]: { profiles: ['mine'] },
    });
    const { config, files } = loadConfig({ env: {}, cwd: root });
    assert.deepEqual(config, { profiles: ['mine'], other: 1 });
    assert.deepEqual(files, [path.join(root, CONFIG_FILE_NAME), path.join(root, OVERRIDE_FILE_NAME)]);
  });

  test('a farther file is not merged into a nearer one', () => {
    const root = makeTree({
      [CONFIG_FILE_NAME]: { profiles: ['outer'], other: 1 },
      [`inner/${CONFIG_FILE_NAME}`]: { profiles: ['inner'] },
    });
    assert.deepEqual(loadConfig({ env: {}, cwd: path.join(root, 'inner') }).config, { profiles: ['inner'] });
  });

  test('BUWP_CLOUD_CONFIG names one file and skips the search', () => {
    const root = makeTree({
      [CONFIG_FILE_NAME]: { profiles: ['found'] },
      'elsewhere/c.json': { profiles: ['explicit'] },
    });
    const explicit = path.join(root, 'elsewhere/c.json');
    assert.deepEqual(findConfigFiles({ env: { [CONFIG_ENV_VAR]: explicit }, cwd: root }), [explicit]);
    assert.deepEqual(loadConfig({ env: { [CONFIG_ENV_VAR]: explicit }, cwd: root }).config, { profiles: ['explicit'] });
  });

  test('a BUWP_CLOUD_CONFIG that does not exist is an error', () => {
    const missing = path.join(os.tmpdir(), 'buwp-cloud-no-such-file.json');
    assert.throws(() => loadConfig({ env: { [CONFIG_ENV_VAR]: missing } }), /Config file not found/);
  });

  test('invalid JSON names the file', () => {
    const root = makeTree({ [CONFIG_FILE_NAME]: '{ not json' });
    assert.throws(() => loadConfig({ env: {}, cwd: root }), /Invalid JSON in .*\.buwp-cloud\.json/);
  });

  test('rejects a non-object and a malformed profiles list, in either file', () => {
    assert.throws(() => loadConfig({ env: {}, cwd: makeTree({ [CONFIG_FILE_NAME]: '[]' }) }), /must contain a JSON object/);
    assert.throws(() => loadConfig({ env: {}, cwd: makeTree({ [CONFIG_FILE_NAME]: { profiles: 'a' } }) }), /must be an array/);
    assert.throws(
      () => loadConfig({ env: {}, cwd: makeTree({ [CONFIG_FILE_NAME]: {}, [OVERRIDE_FILE_NAME]: { profiles: [''] } }) }),
      /\.buwp-cloud\.override\.json.*must be an array/
    );
  });
});

describe('resolveProfiles', () => {
  // Every case passes env explicitly, so an AWS_PROFILE in the shell running the tests can't leak in.
  const config = (profiles, files = ['/x/.buwp-cloud.json']) => () => ({ config: { profiles }, files });
  const noConfig = () => ({ config: {}, files: [] });

  test('--profile flags win over AWS_PROFILE and the config file', () => {
    assert.deepEqual(
      resolveProfiles({ cliProfiles: ['a'], env: { AWS_PROFILE: 'e' }, readConfig: config(['c']) }),
      { profiles: ['a'], source: 'flag', configFiles: [] }
    );
  });

  test('AWS_PROFILE wins over the config file, and is recorded by name', () => {
    assert.deepEqual(
      resolveProfiles({ env: { AWS_PROFILE: 'e' }, readConfig: config(['c']) }),
      { profiles: ['e'], source: 'env', configFiles: [] }
    );
  });

  test('the config file is used when there are no flags and no AWS_PROFILE', () => {
    assert.deepEqual(
      resolveProfiles({ env: {}, readConfig: config(['b', 'c']) }),
      { profiles: ['b', 'c'], source: 'config', configFiles: ['/x/.buwp-cloud.json'] }
    );
  });

  test('with none of them, the default credential chain is searched', () => {
    assert.deepEqual(
      resolveProfiles({ env: {}, readConfig: noConfig }),
      { profiles: [null], source: 'default', configFiles: [] }
    );
    assert.equal(resolveProfiles({ env: { AWS_PROFILE: '' }, readConfig: noConfig }).source, 'default');
  });

  test('the config file is not read when a flag or AWS_PROFILE decides', () => {
    const broken = () => { throw new Error('should not be read'); };
    assert.equal(resolveProfiles({ cliProfiles: ['a'], env: {}, readConfig: broken }).source, 'flag');
    assert.equal(resolveProfiles({ env: { AWS_PROFILE: 'e' }, readConfig: broken }).source, 'env');
  });

  test('duplicates are dropped', () => {
    assert.deepEqual(
      resolveProfiles({ cliProfiles: ['a', 'a', 'b'], env: {}, readConfig: noConfig }).profiles,
      ['a', 'b']
    );
  });
});
