/**
 * Tests for the clusters command: table formatting, JSON output and exit codes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import clustersCommand, { formatTargetsTable } from '../lib/commands/clusters.js';
import { toTarget } from '../lib/index.js';
import { wordpressContext, contextBucket, fakeAws, awsError } from './fixtures.js';

/**
 * Run the command against a fake AWS adapter and capture its output. The env is empty unless
 * given, so an AWS_PROFILE in the shell running the tests can't leak in.
 */
async function runClusters(options, byProfile, config = {}, env = {}) {
  let out = '';
  let err = '';
  const code = await clustersCommand(options, {
    aws: fakeAws(byProfile),
    env,
    readConfig: () => ({ config, files: config.profiles ? ['/x/.buwp-cloud.json'] : [] }),
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
  });
  return { code, out, err };
}

describe('formatTargetsTable', () => {
  test('aligns columns and spells out unset values', () => {
    const dev = toTarget(wordpressContext(), { profile: 'example-nprd' });
    const prod = toTarget(
      wordpressContext({
        STACK_ID: 'wp-long-name',
        WORDPRESS: { env: {} },
        JOBRUNNER: { schedule: 'rate(1 hour)', enabled: false },
      }),
      {}
    );

    const lines = formatTargetsTable([dev, prod]).split('\n');

    assert.equal(lines.length, 3);
    assert.match(lines[0], /^TARGET\s+PROD\s+ENVIRONMENT\s+REGION\s+PROFILE\s+JOB RUNNER$/);
    assert.match(lines[1], /^wp-x-example-test\s+no\s+development\s+us-east-1\s+example-nprd\s+rate\(5 minutes\)$/);
    assert.match(lines[2], /^wp-long-name-example-test\s+yes\s+unset\s+us-east-1\s+\(default\)\s+rate\(1 hour\) \(disabled\)$/);
    assert.equal(lines[0].indexOf('PROD'), lines[1].indexOf('no'), 'columns line up');
  });

  test('paints only the PROD cell of production targets', () => {
    const dev = toTarget(wordpressContext());
    const prod = toTarget(wordpressContext({ STACK_ID: 'wp-p', WORDPRESS: { env: { environmentType: 'production' } } }));

    const lines = formatTargetsTable([dev, prod], { paintProd: (s) => `<${s}>` }).split('\n');

    assert.doesNotMatch(lines[1], /</);
    assert.match(lines[2], /<yes\s*>/);
  });
});

describe('clustersCommand', () => {
  const healthy = { buckets: { [contextBucket('wp-x-example-test')]: wordpressContext() } };

  test('prints a table and exits 0', async () => {
    const { code, out, err } = await runClusters({ profile: ['example-nprd'] }, { 'example-nprd': healthy });

    assert.equal(code, 0);
    assert.match(out, /^TARGET/);
    assert.match(out, /wp-x-example-test/);
    assert.equal(err, '');
  });

  test('--json prints the profiles searched and where they came from, the targets and the errors', async () => {
    const { code, out } = await runClusters({ profile: ['example-nprd'], json: true }, { 'example-nprd': healthy });

    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.profiles, ['example-nprd']);
    assert.equal(parsed.profileSource, 'flag');
    assert.equal(parsed.targets[0].cluster, 'wp-x-wp-cluster-example-test');
    assert.deepEqual(parsed.errors, []);
  });

  test('uses the config file profiles when there is no --profile and no AWS_PROFILE', async () => {
    const { out } = await runClusters({ json: true }, { 'example-nprd': healthy }, { profiles: ['example-nprd'] });

    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.profiles, ['example-nprd']);
    assert.equal(parsed.profileSource, 'config');
    assert.deepEqual(parsed.configFiles, ['/x/.buwp-cloud.json']);
  });

  test('an exported AWS_PROFILE beats the config file and shows by name', async () => {
    const { out } = await runClusters(
      {},
      { 'example-nprd': healthy, 'example-prd': healthy },
      { profiles: ['example-prd'] },
      { AWS_PROFILE: 'example-nprd' }
    );

    assert.match(out, /wp-x-example-test\s+no\s+development\s+us-east-1\s+example-nprd/);
    assert.doesNotMatch(out, /\(default\)|example-prd/);
  });

  test('a partial failure warns on stderr with a hint, and still exits 0', async () => {
    const { code, out, err } = await runClusters(
      { profile: ['example-nprd', 'example-prd'] },
      { 'example-nprd': healthy, 'example-prd': { error: awsError('ExpiredToken', 'expired') } }
    );

    assert.equal(code, 0);
    assert.match(out, /wp-x-example-test/);
    assert.match(err, /Warning:.*example-prd: ExpiredToken: expired/);
    assert.match(err, /\n {2}Check that AWS profile "example-prd" exists/);
  });

  test('--json carries the hint on the error', async () => {
    const { out } = await runClusters(
      { profile: ['example-prd'], json: true },
      { 'example-prd': { error: awsError('ExpiredToken', 'expired') } }
    );

    const [error] = JSON.parse(out).errors;
    assert.equal(error.code, 'ExpiredToken');
    assert.match(error.hint, /"example-prd"/);
  });

  test('exits 1 when every profile fails', async () => {
    const { code, out, err } = await runClusters(
      { profile: ['example-prd'] },
      { 'example-prd': { error: awsError('ExpiredToken', 'expired') } }
    );

    assert.equal(code, 1);
    assert.equal(out, '');
    assert.match(err, /ExpiredToken/);
  });

  test('says so when nothing is found', async () => {
    const { code, out } = await runClusters({ profile: ['example-nprd'] }, { 'example-nprd': { buckets: {} } });

    assert.equal(code, 0);
    assert.equal(out, 'No WordPress clusters found.\n');
  });

  test('an invalid config file exits 1 with the reason', async () => {
    let err = '';
    const code = await clustersCommand({}, {
      aws: fakeAws({}),
      env: {},
      readConfig: () => { throw new Error('Invalid JSON in /x/config.json: Unexpected token'); },
      stderr: (s) => { err += s; },
    });

    assert.equal(code, 1);
    assert.match(err, /Invalid JSON in \/x\/config\.json/);
  });
});
