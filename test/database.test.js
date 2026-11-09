/**
 * Tests for reading database settings from a task definition and resolving its password.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHostPort, databaseFromTaskDefinition, parseSecretRef, readSecretRef, parseMysqlGreeting,
} from '../lib/index.js';
import {
  ecsTaskDefinition, fakeAws, awsError, mysqlGreeting, DB_PASSWORD_REF, ACCOUNT,
} from './fixtures.js';

const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:wp/example-test-AbCdEf`;

describe('parseHostPort', () => {
  test('splits host and port', () => {
    assert.deepEqual(parseHostPort('db.example.internal:3307', 3306), { host: 'db.example.internal', port: 3307 });
  });

  test('uses the default port when there is none', () => {
    assert.deepEqual(parseHostPort('db.example.internal', 3306), { host: 'db.example.internal', port: 3306 });
  });
});

describe('databaseFromTaskDefinition', () => {
  test('reads host, port, user, name and the password reference from the wordpress container', () => {
    assert.deepEqual(databaseFromTaskDefinition(ecsTaskDefinition()), {
      host: 'db.example.internal',
      port: 3306,
      user: 'root',
      name: 'wp_db',
      passwordRef: DB_PASSWORD_REF,
    });
  });

  test('a missing WORDPRESS_DB_HOST or wordpress container is an error', () => {
    assert.throws(() => databaseFromTaskDefinition(ecsTaskDefinition({ dbHost: null })), /no WORDPRESS_DB_HOST/);
    assert.throws(() => databaseFromTaskDefinition({ containerDefinitions: [{ name: 's3proxy' }] }), /no wordpress container/);
  });

  test('a container without the password secret has a null reference', () => {
    assert.equal(databaseFromTaskDefinition(ecsTaskDefinition({ passwordRef: null })).passwordRef, null);
  });
});

describe('parseSecretRef', () => {
  test('splits an ECS reference into the secret, its region, and the JSON key', () => {
    assert.deepEqual(parseSecretRef(DB_PASSWORD_REF), {
      secretId: SECRET_ARN, region: 'us-east-1', jsonKey: 'password', versionStage: null, versionId: null,
    });
  });

  test('a bare secret ARN means the whole secret', () => {
    assert.equal(parseSecretRef(SECRET_ARN).jsonKey, null);
  });

  test('keeps a pinned version stage and ID', () => {
    const ref = parseSecretRef(`${SECRET_ARN}:password:AWSPREVIOUS:v1`);
    assert.equal(ref.versionStage, 'AWSPREVIOUS');
    assert.equal(ref.versionId, 'v1');
  });

  test('rejects anything that is not a Secrets Manager ARN', () => {
    assert.throws(() => parseSecretRef(`arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/x`), /isn't a Secrets Manager reference/);
    assert.throws(() => parseSecretRef('plain-text'), /isn't a Secrets Manager reference/);
  });
});

describe('readSecretRef', () => {
  test('fetches the secret in its own region and picks the JSON key', async () => {
    const aws = fakeAws({}, { secrets: { [SECRET_ARN]: '{"username":"root","password":"s3cret"}' } });

    assert.equal(await readSecretRef(aws, 'example-nprd', DB_PASSWORD_REF), 's3cret');
    assert.deepEqual(aws.calls[0],
      ['getSecretString', 'example-nprd', 'us-east-1', SECRET_ARN, { versionStage: null, versionId: null }]);
  });

  test('returns the whole secret for a bare ARN', async () => {
    const aws = fakeAws({}, { secrets: { [SECRET_ARN]: 'plain' } });
    assert.equal(await readSecretRef(aws, null, SECRET_ARN), 'plain');
  });

  test('explains a secret that lacks the key or is not JSON', async () => {
    await assert.rejects(
      readSecretRef(fakeAws({}, { secrets: { [SECRET_ARN]: '{"username":"root"}' } }), null, DB_PASSWORD_REF),
      /has no "password" field/
    );
    await assert.rejects(
      readSecretRef(fakeAws({}, { secrets: { [SECRET_ARN]: 'not json' } }), null, DB_PASSWORD_REF),
      /isn't the JSON object/
    );
  });

  test('passes AWS errors through', async () => {
    const aws = fakeAws({}, { secrets: { [SECRET_ARN]: awsError('AccessDeniedException', 'denied') } });
    await assert.rejects(readSecretRef(aws, null, DB_PASSWORD_REF), { name: 'AccessDeniedException' });
  });
});

describe('parseMysqlGreeting', () => {
  test('reads the protocol and server version', () => {
    assert.deepEqual(parseMysqlGreeting(mysqlGreeting('8.0.mysql_aurora.3.08.0')),
      { protocol: 10, version: '8.0.mysql_aurora.3.08.0' });
  });

  test('anything else is not a greeting', () => {
    assert.equal(parseMysqlGreeting(null), null);
    assert.equal(parseMysqlGreeting(Buffer.from('+PONG\r\n')), null);
    assert.equal(parseMysqlGreeting(Buffer.from([0x4a, 0, 0, 0, 10, 0x38])), null, 'no NUL terminator');
  });
});
