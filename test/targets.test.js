/**
 * Tests for finding one target by name.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTargetName, findTarget, TargetError } from '../lib/index.js';
import { wordpressContext, contextBucket, fakeAws, awsError } from './fixtures.js';

const stackX = () => wordpressContext({ STACK_ID: 'wp-x', TAGS: { Landscape: 'example-test' } });
const stackY = () => wordpressContext({ STACK_ID: 'wp-y', TAGS: { Landscape: 'example-test' } });

describe('normalizeTargetName', () => {
  test('a stack name is used as is', () => {
    assert.equal(normalizeTargetName('wp-x-example-test'), 'wp-x-example-test');
  });

  test('an ECS cluster or service name becomes the stack name', () => {
    assert.equal(normalizeTargetName('wp-x-wp-cluster-example-test'), 'wp-x-example-test');
    assert.equal(normalizeTargetName('wp-x-wp-service-example-test'), 'wp-x-example-test');
  });

  test('whitespace is trimmed', () => {
    assert.equal(normalizeTargetName('  wp-x-example-test\n'), 'wp-x-example-test');
  });
});

describe('findTarget', () => {
  const buckets = {
    [contextBucket('wp-x-example-test')]: stackX(),
    [contextBucket('wp-y-example-test')]: stackY(),
  };

  test('reads only the matching context', async () => {
    const aws = fakeAws({ 'example-nprd': { buckets } });

    const { target, errors } = await findTarget('wp-x-example-test', { profiles: ['example-nprd'], source: 'flag', aws });

    assert.equal(target.name, 'wp-x-example-test');
    assert.equal(target.profile, 'example-nprd');
    assert.deepEqual(errors, []);
    const reads = aws.calls.filter(([call]) => call === 'getJson');
    assert.deepEqual(reads.map(([, , bucket]) => bucket), [contextBucket('wp-x-example-test')]);
  });

  test('accepts the ECS cluster name', async () => {
    const aws = fakeAws({ 'example-nprd': { buckets } });
    const { target } = await findTarget('wp-y-wp-cluster-example-test', { profiles: ['example-nprd'], source: 'flag', aws });
    assert.equal(target.name, 'wp-y-example-test');
  });

  test('is found in whichever profile has it, even when another profile fails', async () => {
    const aws = fakeAws({
      'example-prd': { error: awsError('ExpiredToken', 'expired') },
      'example-nprd': { buckets },
    });

    const { target, errors } = await findTarget('wp-x-example-test', { profiles: ['example-prd', 'example-nprd'], source: 'config', aws });

    assert.equal(target.profile, 'example-nprd');
    assert.equal(errors[0].profile, 'example-prd');
  });

  test('not found suggests targets that contain what was typed', async () => {
    const aws = fakeAws({ 'example-nprd': { buckets } });

    await assert.rejects(
      findTarget('wp-x', { profiles: ['example-nprd'], source: 'config', aws }),
      (err) => {
        assert.ok(err instanceof TargetError);
        assert.match(err.message, /No target named "wp-x" in example-nprd \(from the config file\)/);
        assert.deepEqual(err.suggestions, ['wp-x-example-test']);
        return true;
      }
    );
  });

  test('not found with no close name lists every target', async () => {
    const aws = fakeAws({ 'example-nprd': { buckets } });

    await assert.rejects(
      findTarget('nothing-like-it', { profiles: ['example-nprd'], source: 'flag', aws }),
      (err) => {
        assert.deepEqual(err.suggestions, ['wp-x-example-test', 'wp-y-example-test']);
        return true;
      }
    );
  });

  test('not found carries the profiles that could not be searched', async () => {
    const aws = fakeAws({
      'example-nprd': { buckets },
      'example-prd': { error: awsError('ExpiredToken', 'expired') },
    });

    await assert.rejects(
      findTarget('wp-z-example-prod', { profiles: ['example-nprd', 'example-prd'], source: 'config', aws }),
      (err) => {
        assert.equal(err.errors.length, 1);
        assert.equal(err.errors[0].code, 'ExpiredToken');
        return true;
      }
    );
  });

  test('the same name in two places is ambiguous', async () => {
    const aws = fakeAws({
      'example-nprd': { buckets: { [contextBucket('wp-x-example-test')]: stackX() } },
      'example-other': { buckets: { [contextBucket('wp-x-example-test')]: stackX() } },
    });

    await assert.rejects(
      findTarget('wp-x-example-test', { profiles: ['example-nprd', 'example-other'], source: 'flag', aws }),
      (err) => {
        assert.match(err.message, /more than one place \(example-nprd us-east-1, example-other us-east-1\)/);
        assert.match(err.message, /--profile/);
        assert.equal(err.matches.length, 2);
        return true;
      }
    );
  });
});
