/**
 * Tests for the shared error helpers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, describeError, credentialHint } from '../lib/index.js';
import { awsError } from './fixtures.js';

describe('errorCode and describeError', () => {
  test('keep the AWS error name', () => {
    const err = awsError('AccessDenied', 'Access Denied');
    assert.equal(errorCode(err), 'AccessDenied');
    assert.equal(describeError(err), 'AccessDenied: Access Denied');
  });

  test('a plain Error has no code and keeps its message', () => {
    assert.equal(errorCode(new Error('boom')), null);
    assert.equal(describeError(new Error('boom')), 'boom');
  });

  test('a non-Error is stringified', () => {
    assert.equal(errorCode('boom'), null);
    assert.equal(describeError('boom'), 'boom');
  });
});

describe('credentialHint', () => {
  const context = { source: 'config' };

  test('names the profile to refresh', () => {
    assert.equal(
      credentialHint({ code: 'ExpiredToken', profile: 'example-prd' }, context),
      'Check that AWS profile "example-prd" exists and its credentials haven\'t expired.'
    );
  });

  test('says when the profile came from AWS_PROFILE', () => {
    assert.match(
      credentialHint({ code: 'CredentialsProviderError', profile: 'example-prd' }, { ...context, source: 'env' }),
      /"example-prd" \(from AWS_PROFILE\)/
    );
  });

  test('with no profile at all, lists the ways to give one', () => {
    const hint = credentialHint({ code: 'CredentialsProviderError', profile: null }, context);
    assert.match(hint, /--profile/);
    assert.match(hint, /AWS_PROFILE/);
    assert.match(hint, /\.buwp-cloud\.json/);
    assert.match(hint, /config --init/);
  });

  test('gives no hint for errors that are not about credentials', () => {
    assert.equal(credentialHint({ code: 'AccessDenied', profile: 'example-prd' }, context), null);
    assert.equal(credentialHint({ code: null, profile: 'example-prd' }, context), null);
  });
});
