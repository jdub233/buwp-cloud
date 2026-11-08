/**
 * Tests for the config command: --show, --init and --validate.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import configCommand from '../lib/commands/config.js';
import { CONFIG_FILE_NAME, OVERRIDE_FILE_NAME } from '../lib/index.js';

const tempDirs = [];

function makeDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buwp-cloud-test-'));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return dir;
}

/** Run the command in a directory with a given env, capturing output. */
async function runConfig(options, cwd, env = {}) {
  let out = '';
  let err = '';
  const code = await configCommand(options, {
    env, cwd, stdout: (s) => { out += s; }, stderr: (s) => { err += s; },
  });
  return { code, out, err };
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('config --show', () => {
  test('is the default, and shows the file and the profiles it resolves to', async () => {
    const dir = makeDir({ [CONFIG_FILE_NAME]: { profiles: ['example-nprd', 'example-prd'] } });
    const { code, out } = await runConfig({}, dir);

    assert.equal(code, 0);
    assert.match(out, new RegExp(`Config file: +${path.join(dir, CONFIG_FILE_NAME)}`));
    assert.match(out, /Profiles: +example-nprd, example-prd +\(from the config file\)/);
  });

  test('lists the override file too', async () => {
    const dir = makeDir({ [CONFIG_FILE_NAME]: { profiles: ['a'] }, [OVERRIDE_FILE_NAME]: { profiles: ['b'] } });
    const { out } = await runConfig({ show: true }, dir);

    assert.match(out, new RegExp(OVERRIDE_FILE_NAME.replace(/\./g, '\\.')));
    assert.match(out, /Profiles: +b /);
  });

  test('says when AWS_PROFILE overrides the file', async () => {
    const dir = makeDir({ [CONFIG_FILE_NAME]: { profiles: ['a'] } });
    const { out } = await runConfig({ show: true }, dir, { AWS_PROFILE: 'example-nprd' });

    assert.match(out, /Profiles: +example-nprd +\(from AWS_PROFILE, which overrides the config file\)/);
  });

  test('says when there is no file', async () => {
    const dir = makeDir();
    const { code, out } = await runConfig({ show: true }, dir);

    assert.equal(code, 0);
    assert.match(out, /Config file: +none found/);
    assert.match(out, /default credential chain/);
  });

  test('--json gives files, config, profiles and source', async () => {
    const dir = makeDir({ [CONFIG_FILE_NAME]: { profiles: ['a'] } });
    const { out } = await runConfig({ show: true, json: true }, dir);

    assert.deepEqual(JSON.parse(out), {
      configFiles: [path.join(dir, CONFIG_FILE_NAME)],
      config: { profiles: ['a'] },
      profiles: ['a'],
      profileSource: 'config',
    });
  });

  test('an invalid file exits 1 with the reason', async () => {
    const dir = makeDir({ [CONFIG_FILE_NAME]: '{ not json' });
    const { code, err } = await runConfig({ show: true }, dir);

    assert.equal(code, 1);
    assert.match(err, /Invalid JSON/);
  });
});

describe('config --init', () => {
  test('writes the named profiles to .buwp-cloud.json in the current directory', async () => {
    const dir = makeDir();
    const { code, out } = await runConfig({ init: true, profile: ['example-nprd', 'example-prd'] }, dir);

    assert.equal(code, 0);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE_NAME), 'utf8')),
      { profiles: ['example-nprd', 'example-prd'] }
    );
    assert.match(out, /Created/);
    assert.match(out, /keep it out of public repos/);
  });

  test('falls back to AWS_PROFILE', async () => {
    const dir = makeDir();
    await runConfig({ init: true, profile: [] }, dir, { AWS_PROFILE: 'example-nprd' });

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE_NAME), 'utf8')), { profiles: ['example-nprd'] });
  });

  test('refuses without any profile', async () => {
    const dir = makeDir();
    const { code, err } = await runConfig({ init: true, profile: [] }, dir);

    assert.equal(code, 1);
    assert.match(err, /--profile <name>/);
    assert.equal(fs.existsSync(path.join(dir, CONFIG_FILE_NAME)), false);
  });

  test('will not replace an existing file without --force', async () => {
    const dir = makeDir({ [CONFIG_FILE_NAME]: { profiles: ['old'] } });

    const refused = await runConfig({ init: true, profile: ['new'] }, dir);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /already exists/);

    const forced = await runConfig({ init: true, profile: ['new'], force: true }, dir);
    assert.equal(forced.code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE_NAME), 'utf8')), { profiles: ['new'] });
  });
});

describe('config --validate', () => {
  test('a valid file exits 0', async () => {
    const dir = makeDir({ [CONFIG_FILE_NAME]: { profiles: ['a'] } });
    const { code, out } = await runConfig({ validate: true }, dir);

    assert.equal(code, 0);
    assert.match(out, /Valid:/);
  });

  test('an invalid file exits 1', async () => {
    const dir = makeDir({ [CONFIG_FILE_NAME]: { profiles: 'a' } });
    const { code, err } = await runConfig({ validate: true }, dir);

    assert.equal(code, 1);
    assert.match(err, /must be an array/);
  });

  test('no file is not an error', async () => {
    const { code, out } = await runConfig({ validate: true }, makeDir());

    assert.equal(code, 0);
    assert.match(out, /No config file found/);
  });
});
