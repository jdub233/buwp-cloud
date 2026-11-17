/**
 * Tests for reading profile names from the AWS CLI's shared files.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { iniSections, profileFromConfigSection, listAwsProfiles, sharedFilePaths } from '../lib/index.js';

const tempDirs = [];
after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A home directory with the given ~/.aws files. */
function homeWith(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buwp-cloud-home-'));
  tempDirs.push(home);
  fs.mkdirSync(path.join(home, '.aws'));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, '.aws', name), text);
  }
  return home;
}

const CONFIG = `
# a comment
[default]
region = us-east-1

[profile example-nprd]
region = us-east-1
output = json

[profile  example-tool ]
credential_process = /usr/local/bin/example-login --account example

[sso-session example-sso]
sso_start_url = https://example.invalid/start

[services example-services]
`;

const CREDENTIALS = `
[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
[example-nprd]
aws_session_token = not-a-real-token
; another comment
[example-prd]
aws_session_token = not-a-real-token
`;

describe('iniSections', () => {
  test('keeps header names and key names, and no values', () => {
    const sections = iniSections(CREDENTIALS);
    assert.deepEqual(sections.map((s) => s.name), ['default', 'example-nprd', 'example-prd']);
    assert.deepEqual(sections[0].keys, ['aws_access_key_id', 'aws_secret_access_key']);
    assert.doesNotMatch(JSON.stringify(sections), /not-a-real|AKIA|EXAMPLEKEY/);
  });
});

describe('profileFromConfigSection', () => {
  test('reads [default] and [profile name], and nothing else', () => {
    assert.equal(profileFromConfigSection('default'), 'default');
    assert.equal(profileFromConfigSection('profile example-nprd'), 'example-nprd');
    assert.equal(profileFromConfigSection('sso-session example-sso'), null);
    assert.equal(profileFromConfigSection('services example-services'), null);
    assert.equal(profileFromConfigSection('example-nprd'), null);
  });
});

describe('listAwsProfiles', () => {
  test('lists config profiles in file order, then credentials-only ones, once each', () => {
    const home = homeWith({ config: CONFIG, credentials: CREDENTIALS });
    const { profiles, files } = listAwsProfiles({ env: {}, homedir: home });

    assert.deepEqual(profiles, [
      { name: 'default', files: ['config', 'credentials'], credentialProcess: false },
      { name: 'example-nprd', files: ['config', 'credentials'], credentialProcess: false },
      { name: 'example-tool', files: ['config'], credentialProcess: true },
      { name: 'example-prd', files: ['credentials'], credentialProcess: false },
    ]);
    assert.deepEqual(files, [path.join(home, '.aws', 'config'), path.join(home, '.aws', 'credentials')]);
  });

  test('skips a missing file, and finds nothing when both are missing', () => {
    const home = homeWith({ credentials: '[example-nprd]\n' });
    assert.deepEqual(listAwsProfiles({ env: {}, homedir: home }).profiles.map((p) => p.name), ['example-nprd']);
    assert.deepEqual(listAwsProfiles({ env: {}, homedir: homeWith({}) }), { profiles: [], files: [] });
  });

  test('follows AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE', () => {
    const home = homeWith({ elsewhere: '[profile example-elsewhere]\n' });
    const env = { AWS_CONFIG_FILE: path.join(home, '.aws', 'elsewhere'), AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'none') };

    assert.deepEqual(sharedFilePaths({ env, homedir: home }), { config: env.AWS_CONFIG_FILE, credentials: env.AWS_SHARED_CREDENTIALS_FILE });
    assert.deepEqual(listAwsProfiles({ env, homedir: home }).profiles.map((p) => p.name), ['example-elsewhere']);
  });
});
