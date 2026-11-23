/**
 * Tests for the clusters command: table formatting, JSON output and exit codes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import clustersCommand, { groupByProfile, formatClusterGroups } from '../lib/commands/clusters.js';
import { toTarget } from '../lib/index.js';
import { wordpressContext, contextBucket, fakeAws, awsError, ACCOUNT } from './fixtures.js';

const OTHER_ACCOUNT = '210987654321';

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

describe('groupByProfile', () => {
  const nprd = toTarget(wordpressContext(), { profile: 'example-nprd' });
  const other = toTarget(wordpressContext({ STACK_ID: 'wp-z', ACCOUNT: OTHER_ACCOUNT }), { profile: 'example-other' });
  const viaDefault = toTarget(wordpressContext(), { profile: null });

  test('keeps the search order, leaves out failed profiles, and spots a repeated account', () => {
    const groups = groupByProfile(
      ['example-other', 'example-prd', 'example-nprd', null, 'example-empty'],
      [nprd, other, viaDefault],
      new Set(['example-prd'])
    );

    assert.deepEqual(groups.map((g) => [g.profile, g.account, g.sameAs, g.targets.length]), [
      ['example-other', OTHER_ACCOUNT, null, 1],
      ['example-nprd', ACCOUNT, null, 1],
      [null, ACCOUNT, 'example-nprd', 1],
      ['example-empty', null, null, 0],
    ]);
  });

  test('names the default credential chain when it reached an account first', () => {
    const [, second] = groupByProfile([null, 'example-nprd'], [viaDefault, nprd]);
    assert.equal(second.sameAs, '(default credential chain)');
  });
});

describe('formatClusterGroups', () => {
  test('a table per profile under its heading, lined up across tables, with unset values spelled out', () => {
    const dev = toTarget(wordpressContext(), { profile: 'example-nprd' });
    const prod = toTarget(
      wordpressContext({
        STACK_ID: 'wp-long-name',
        ACCOUNT: OTHER_ACCOUNT,
        WORDPRESS: { env: {} },
        JOBRUNNER: { schedule: 'rate(1 hour)', enabled: false },
      }),
      { profile: 'example-prd' }
    );
    const groups = groupByProfile(['example-nprd', 'example-prd', 'example-empty'], [dev, prod]);

    const lines = formatClusterGroups(groups).split('\n');

    assert.deepEqual(lines.filter((l) => !l.startsWith('  ')), [
      `example-nprd (account ${ACCOUNT})`,
      '',
      `example-prd (account ${OTHER_ACCOUNT})`,
      '',
      'example-empty',
    ]);
    assert.match(lines[1], /^ {2}TARGET\s+PROD\s+ENVIRONMENT\s+REGION\s+JOB RUNNER$/);
    assert.match(lines[2], /^ {2}wp-x-example-test\s+no\s+development\s+us-east-1\s+rate\(5 minutes\)$/);
    assert.match(lines[6], /^ {2}wp-long-name-example-test\s+yes\s+unset\s+us-east-1\s+rate\(1 hour\) \(disabled\)$/);
    assert.equal(lines[2].indexOf('no'), lines[6].indexOf('yes'), 'columns line up across tables');
    assert.equal(lines.at(-1), '  No WordPress clusters.');
  });

  test('marks a profile that reaches an account already listed', () => {
    const groups = groupByProfile(['example-nprd', null], [
      toTarget(wordpressContext(), { profile: 'example-nprd' }),
      toTarget(wordpressContext(), { profile: null }),
    ]);
    assert.match(formatClusterGroups(groups), /^\(default credential chain\) \(account \d+, same account as example-nprd\)$/m);
  });

  test('paints only the PROD cell of production targets, and the heading', () => {
    const dev = toTarget(wordpressContext(), { profile: 'example-nprd' });
    const prod = toTarget(wordpressContext({ STACK_ID: 'wp-p', WORDPRESS: { env: { environmentType: 'production' } } }), { profile: 'example-nprd' });

    const lines = formatClusterGroups(groupByProfile(['example-nprd'], [dev, prod]), {
      paintProd: (s) => `<${s}>`,
      paintHeading: (s) => `*${s}*`,
    }).split('\n');

    assert.match(lines[0], /^\*example-nprd\* \(account/);
    assert.doesNotMatch(lines[2], /</);
    assert.match(lines[3], /<yes\s*>/);
  });
});

describe('clustersCommand', () => {
  const healthy = { buckets: { [contextBucket('wp-x-example-test')]: wordpressContext() } };

  test('prints a table and exits 0', async () => {
    const { code, out, err } = await runClusters({ profile: ['example-nprd'] }, { 'example-nprd': healthy });

    assert.equal(code, 0);
    assert.match(out, new RegExp(`^example-nprd \\(account ${ACCOUNT}\\)\\n {2}TARGET`));
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

    assert.match(out, /^example-nprd \(account/);
    assert.match(out, /wp-x-example-test\s+no\s+development\s+us-east-1/);
    assert.doesNotMatch(out, /\(default|example-prd/);
  });

  test('a partial failure warns on stderr with a hint, and still exits 0', async () => {
    const { code, out, err } = await runClusters(
      { profile: ['example-nprd', 'example-prd'] },
      { 'example-nprd': healthy, 'example-prd': { error: awsError('ExpiredToken', 'expired') } }
    );

    assert.equal(code, 0);
    assert.match(out, /wp-x-example-test/);
    assert.doesNotMatch(out, /example-prd/, 'a failed profile gets a warning, not a table');
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
