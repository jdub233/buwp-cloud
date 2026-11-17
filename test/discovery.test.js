/**
 * Tests for target discovery from ContextLog buckets.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseContextBucketName,
  isWordpressContext,
  isProduction,
  toTarget,
  discoverTargets,
  CONTEXT_KEY,
} from '../lib/index.js';
import {
  ACCOUNT, wordpressContext, edgeContext, contextBucket, fakeAws, awsError,
} from './fixtures.js';

describe('parseContextBucketName', () => {
  test('splits a ContextLog bucket into stack name, account and region', () => {
    const name = contextBucket('wp-x-example-test');
    assert.deepEqual(parseContextBucketName(name), {
      bucket: name, stackName: 'wp-x-example-test', account: ACCOUNT, region: 'us-east-1',
    });
  });

  test('reads regions other than us-east-1', () => {
    assert.equal(parseContextBucketName(contextBucket('wp-x-devl', 'us-east-2')).region, 'us-east-2');
    assert.equal(parseContextBucketName(contextBucket('wp-x-devl', 'us-gov-west-1')).region, 'us-gov-west-1');
  });

  test('ignores buckets that are not ContextLog buckets', () => {
    assert.equal(parseContextBucketName('some-unrelated-bucket'), null);
    assert.equal(parseContextBucketName('wp-x-context-config-12345-us-east-1'), null);
    assert.equal(parseContextBucketName(`wp-x-context-config-${ACCOUNT}`), null);
  });
});

describe('isWordpressContext', () => {
  test('accepts a bu-wp-ecs context', () => {
    assert.equal(isWordpressContext(wordpressContext()), true);
  });

  test('accepts a context written before bu-wp-ecs added TYPE', () => {
    const context = wordpressContext();
    delete context.TYPE;
    assert.equal(isWordpressContext(context), true);
  });

  test('rejects an edge stack that shares the bucket pattern', () => {
    assert.equal(isWordpressContext(edgeContext()), false);
  });

  test('rejects contexts missing STACK_ID or Landscape, and non-objects', () => {
    assert.equal(isWordpressContext(wordpressContext({ STACK_ID: '' })), false);
    assert.equal(isWordpressContext(wordpressContext({ TAGS: {} })), false);
    assert.equal(isWordpressContext(null), false);
    assert.equal(isWordpressContext('context'), false);
  });
});

describe('isProduction', () => {
  const withType = (environmentType) =>
    wordpressContext({ WORDPRESS: { env: { environmentType } } });

  test('development, local and staging are not production', () => {
    assert.equal(isProduction(withType('development')), false);
    assert.equal(isProduction(withType('local')), false);
    assert.equal(isProduction(withType('staging')), false);
  });

  test('production is production', () => {
    assert.equal(isProduction(withType('production')), true);
  });

  test('an unset environmentType is production, as bu-wp-ecs treats it', () => {
    assert.equal(isProduction(withType(undefined)), true);
    assert.equal(isProduction(wordpressContext({ WORDPRESS: {} })), true);
  });

  test('an unknown environmentType is production, as bu-wp-ecs treats it', () => {
    assert.equal(isProduction(withType('prod')), true);
  });
});

describe('toTarget', () => {
  test('derives the target, cluster and service names from STACK_ID and Landscape', () => {
    const target = toTarget(wordpressContext(), { profile: 'example-nprd', bucket: 'b', region: 'us-east-1' });
    assert.equal(target.name, 'wp-x-example-test');
    assert.equal(target.cluster, 'wp-x-wp-cluster-example-test');
    assert.equal(target.service, 'wp-x-wp-service-example-test');
    assert.equal(target.profile, 'example-nprd');
    assert.equal(target.account, ACCOUNT);
    assert.equal(target.region, 'us-east-1');
    assert.equal(target.host, 'wp-example-test.example.edu');
    assert.equal(target.contextBucket, 'b');
    assert.equal(target.production, false);
    assert.equal(target.environmentType, 'development');
  });

  test('reports autoscaling as bu-wp-ecs reads it: on for any truthy AUTOSCALING', () => {
    assert.equal(toTarget(wordpressContext()).autoscaling, false);
    assert.equal(toTarget(wordpressContext({ AUTOSCALING: true })).autoscaling, true);
    assert.equal(toTarget(wordpressContext({ AUTOSCALING: false })).autoscaling, false);
  });

  test('reports the job runner schedule and whether it is enabled', () => {
    assert.deepEqual(toTarget(wordpressContext()).jobRunner, { schedule: 'rate(5 minutes)', enabled: true });
    assert.deepEqual(
      toTarget(wordpressContext({ JOBRUNNER: { schedule: 'rate(1 hour)', enabled: false } })).jobRunner,
      { schedule: 'rate(1 hour)', enabled: false }
    );
    assert.equal(toTarget(wordpressContext({ JOBRUNNER: undefined })).jobRunner, null);
  });

  test('tolerates a pre-TYPE context with no DNS block', () => {
    const context = wordpressContext({ DNS: undefined });
    delete context.TYPE;
    const target = toTarget(context);
    assert.equal(target.type, null);
    assert.equal(target.host, null);
    assert.equal(target.profile, null);
  });

  test('falls back to the bucket region when the context has no REGION', () => {
    assert.equal(toTarget(wordpressContext({ REGION: undefined }), { region: 'us-east-2' }).region, 'us-east-2');
  });
});

describe('discoverTargets', () => {
  test('keeps WordPress contexts and skips other stacks and unrelated buckets', async () => {
    const aws = fakeAws({
      'example-nprd': {
        buckets: {
          [contextBucket('wp-x-example-test')]: wordpressContext(),
          [contextBucket('shib-x-example-test')]: edgeContext(),
          'some-unrelated-bucket': 'never read',
        },
      },
    });

    const { targets, errors } = await discoverTargets({ profiles: ['example-nprd'], aws });

    assert.deepEqual(targets.map((t) => t.name), ['wp-x-example-test']);
    assert.deepEqual(errors, []);
    const reads = aws.calls.filter(([call]) => call === 'getJson');
    assert.equal(reads.length, 2, 'only ContextLog buckets are read');
  });

  test('reads each context from its bucket region', async () => {
    const east2 = contextBucket('wp-y-example-devl', 'us-east-2');
    const aws = fakeAws({
      'example-nprd': {
        buckets: { [east2]: wordpressContext({ STACK_ID: 'wp-y', REGION: 'us-east-2' }) },
      },
    });

    await discoverTargets({ profiles: ['example-nprd'], aws });

    assert.deepEqual(
      aws.calls.find(([call]) => call === 'getJson'),
      ['getJson', 'example-nprd', east2, CONTEXT_KEY, 'us-east-2']
    );
  });

  test('a failing profile is reported without hiding the others', async () => {
    const aws = fakeAws({
      'example-nprd': { buckets: { [contextBucket('wp-x-example-test')]: wordpressContext() } },
      'example-prd': { error: awsError('ExpiredToken', 'The security token included in the request is expired') },
    });

    const { targets, errors } = await discoverTargets({ profiles: ['example-nprd', 'example-prd'], aws });

    assert.deepEqual(targets.map((t) => t.name), ['wp-x-example-test']);
    assert.deepEqual(errors, [{
      profile: 'example-prd',
      code: 'ExpiredToken',
      message: 'ExpiredToken: The security token included in the request is expired',
    }]);
  });

  test('an unreadable context is reported with its bucket, and the rest still load', async () => {
    const broken = contextBucket('wp-z-example-test');
    const aws = fakeAws({
      'example-nprd': {
        buckets: {
          [contextBucket('wp-x-example-test')]: wordpressContext(),
          [broken]: awsError('AccessDenied', 'Access Denied'),
        },
      },
    });

    const { targets, errors } = await discoverTargets({ profiles: ['example-nprd'], aws });

    assert.equal(targets.length, 1);
    assert.deepEqual(errors, [{
      profile: 'example-nprd', bucket: broken, code: 'AccessDenied', message: 'AccessDenied: Access Denied',
    }]);
  });

  test('sorts targets by name across profiles', async () => {
    const aws = fakeAws({
      'example-prd': { buckets: { [contextBucket('wp-y-example-prod')]: wordpressContext({ STACK_ID: 'wp-y', TAGS: { Landscape: 'example-prod' } }) } },
      'example-nprd': { buckets: { [contextBucket('wp-x-example-test')]: wordpressContext({ STACK_ID: 'wp-x' }) } },
    });

    const { targets } = await discoverTargets({ profiles: ['example-prd', 'example-nprd'], aws });

    assert.deepEqual(targets.map((t) => t.name), ['wp-x-example-test', 'wp-y-example-prod']);
  });

  test('a null profile is passed through as the default credential chain', async () => {
    const aws = fakeAws({ null: { buckets: { [contextBucket('wp-x-example-test')]: wordpressContext() } } });

    const { targets } = await discoverTargets({ profiles: [null], aws });

    assert.equal(targets[0].profile, null);
    assert.deepEqual(aws.calls[0], ['listBucketNames', null]);
  });
});
