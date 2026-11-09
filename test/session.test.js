/**
 * Tests for building, printing and running session commands.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import {
  toTarget, execArgs, withTargetAccount, shellQuote, formatCommandLine, productionNotice, runInteractive,
} from '../lib/index.js';
import { wordpressContext } from './fixtures.js';

const target = (profile = 'example-nprd') => toTarget(wordpressContext(), { profile });
const task = { taskId: 'abc123' };

describe('execArgs', () => {
  test('targets the wordpress container of the picked task, with region and profile', () => {
    assert.deepEqual(execArgs(target(), task, '/bin/bash'), [
      'ecs', 'execute-command',
      '--cluster', 'wp-x-wp-cluster-example-test',
      '--task', 'abc123',
      '--container', 'wordpress',
      '--interactive',
      '--command', '/bin/bash',
      '--region', 'us-east-1',
      '--profile', 'example-nprd',
    ]);
  });

  test('leaves --profile off for the default credential chain', () => {
    const args = withTargetAccount(target(null), ['sts', 'get-caller-identity']);
    assert.deepEqual(args, ['sts', 'get-caller-identity', '--region', 'us-east-1']);
  });
});

describe('shellQuote and formatCommandLine', () => {
  test('plain words stay bare', () => {
    assert.equal(shellQuote('wp-x-wp-cluster-example-test'), 'wp-x-wp-cluster-example-test');
    assert.equal(shellQuote('/bin/bash'), '/bin/bash');
  });

  test('anything else is single-quoted, with embedded quotes escaped', () => {
    assert.equal(shellQuote('sh -c "wp option get siteurl"'), `'sh -c "wp option get siteurl"'`);
    assert.equal(shellQuote(`it's`), `'it'\\''s'`);
    assert.equal(shellQuote(''), `''`);
  });

  test('a printed command line round-trips through a shell', () => {
    assert.equal(
      formatCommandLine('aws', ['ecs', 'execute-command', '--command', 'sh -c "echo $HOME"']),
      `aws ecs execute-command --command 'sh -c "echo $HOME"'`
    );
  });
});

describe('productionNotice', () => {
  test('names the target and profile', () => {
    const prod = toTarget(wordpressContext({ WORDPRESS: { env: { environmentType: 'production' } } }), { profile: 'example-prd' });
    assert.equal(productionNotice(prod),
      'PRODUCTION: wp-x-example-test (environmentType production; profile example-prd)');
  });

  test('says when production comes from an unset environmentType', () => {
    const unset = toTarget(wordpressContext({ WORDPRESS: { env: {} } }), {});
    assert.equal(productionNotice(unset),
      'PRODUCTION: wp-x-example-test (environmentType unset, treated as production; profile (default))');
  });
});

describe('runInteractive', () => {
  /** A spawn that records its call and returns a child the test controls. */
  function fakeSpawn() {
    const child = new EventEmitter();
    const spawn = (command, args, options) => {
      spawn.call = { command, args, options };
      return child;
    };
    return { spawn, child };
  }

  test('attaches the child to this terminal and resolves with its exit code', async () => {
    const { spawn, child } = fakeSpawn();
    const done = runInteractive('aws', ['--version'], { spawn });
    child.emit('close', 3, null);

    assert.equal(await done, 3);
    assert.deepEqual(spawn.call, { command: 'aws', args: ['--version'], options: { stdio: 'inherit' } });
  });

  test('a child ended by a signal resolves with 128 plus the signal number', async () => {
    const { spawn, child } = fakeSpawn();
    const done = runInteractive('aws', [], { spawn });
    child.emit('close', null, 'SIGTERM');

    assert.equal(await done, 143);
  });

  test('ignores SIGINT only while the child runs', async () => {
    const before = process.listenerCount('SIGINT');
    const { spawn, child } = fakeSpawn();
    const done = runInteractive('aws', [], { spawn });

    assert.equal(process.listenerCount('SIGINT'), before + 1);
    child.emit('close', 0, null);
    await done;
    assert.equal(process.listenerCount('SIGINT'), before);
  });

  test('rejects when the command cannot start, and stops ignoring SIGINT', async () => {
    const before = process.listenerCount('SIGINT');
    const { spawn, child } = fakeSpawn();
    const done = runInteractive('aws', [], { spawn });
    const err = Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);

    await assert.rejects(done, /ENOENT/);
    assert.equal(process.listenerCount('SIGINT'), before);
  });
});
