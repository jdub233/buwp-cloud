/**
 * Tests for the shell command. Nothing here opens a session: `run` is a fake.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import shellCommand, { SHELL_COMMAND } from '../lib/commands/shell.js';
import {
  wordpressContext, contextBucket, fakeAws, awsError, ecsTask, ecsService,
} from './fixtures.js';

const devContext = () => wordpressContext();
const prodContext = () => wordpressContext({ WORDPRESS: { env: { environmentType: 'production' } } });

/** ECS answers for a one-task service. */
const oneTask = (task = ecsTask({ id: 'task1' })) => ({ service: ecsService(), tasks: [task] });

/**
 * Run the command against fakes. `run` records what it would have run and returns `exitCode`.
 */
async function runShell(options = {}, {
  context = devContext(), ecs = oneTask(), interactive = true, exitCode = 0, runError,
} = {}) {
  let out = '';
  let err = '';
  const ran = [];
  const code = await shellCommand('wp-x-example-test', options, {
    aws: fakeAws({ 'example-nprd': { buckets: { [contextBucket('wp-x-example-test')]: context } } }, ecs),
    env: {},
    readConfig: () => ({ config: { profiles: ['example-nprd'] }, files: [] }),
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    isInteractive: () => interactive,
    run: async (command, args) => {
      ran.push([command, args]);
      if (runError) {
        throw runError;
      }
      return exitCode;
    },
  });
  return { code, out, err, ran };
}

describe('shell', () => {
  test('opens bash in the picked task and returns the session exit code', async () => {
    const { code, ran, err } = await runShell({}, { exitCode: 7 });

    assert.equal(code, 7);
    assert.equal(ran.length, 1);
    const [command, args] = ran[0];
    assert.equal(command, 'aws');
    assert.deepEqual(args.slice(0, 2), ['ecs', 'execute-command']);
    assert.equal(args[args.indexOf('--task') + 1], 'task1');
    assert.equal(args[args.indexOf('--container') + 1], 'wordpress');
    assert.equal(args[args.indexOf('--command') + 1], SHELL_COMMAND);
    assert.equal(args[args.indexOf('--profile') + 1], 'example-nprd');
    assert.match(err, /Opening a shell in wp-x-example-test, task task1/);
  });

  test('--task pins the task', async () => {
    const ecs = { service: ecsService(), tasks: [ecsTask({ id: 'a' }), ecsTask({ id: 'b', startedAt: '2027-01-01T00:00:00Z' })] };
    const { ran } = await runShell({ task: 'b' }, { ecs });

    const [, args] = ran[0];
    assert.equal(args[args.indexOf('--task') + 1], 'b');
  });

  test('--print prints the command alone on stdout and runs nothing', async () => {
    const { code, out, err, ran } = await runShell({ print: true });

    assert.equal(code, 0);
    assert.deepEqual(ran, []);
    assert.equal(out.split('\n').filter(Boolean).length, 1);
    assert.match(out, /^aws ecs execute-command --cluster wp-x-wp-cluster-example-test --task task1 --container wordpress --interactive --command \/bin\/bash --region us-east-1 --profile example-nprd\n$/);
    assert.match(err, /# wp-x-example-test, task task1/);
  });

  test('opens a session on a production target, labeled before it opens', async () => {
    const { code, err, ran } = await runShell({}, { context: prodContext() });

    assert.equal(code, 0);
    assert.equal(ran.length, 1);
    assert.match(err, /PRODUCTION: wp-x-example-test \(environmentType production; profile example-nprd\)\n.*Opening a shell/);
  });

  test('labels production in --print too, on stderr only', async () => {
    const { code, out, err } = await runShell({ print: true }, { context: prodContext() });

    assert.equal(code, 0);
    assert.match(out, /^aws ecs execute-command/);
    assert.doesNotMatch(out, /PRODUCTION/);
    assert.match(err, /PRODUCTION: wp-x-example-test/);
  });

  test('a nonprod target gets no production label', async () => {
    const { err } = await runShell({});

    assert.doesNotMatch(err, /PRODUCTION/);
  });

  test('refuses without a terminal, pointing to --print', async () => {
    const { code, err, ran } = await runShell({}, { interactive: false });

    assert.equal(code, 1);
    assert.deepEqual(ran, []);
    assert.match(err, /needs an interactive terminal/);
    assert.match(err, /--print/);
  });

  test('--print works without a terminal', async () => {
    const { code, out } = await runShell({ print: true }, { interactive: false });

    assert.equal(code, 0);
    assert.match(out, /^aws ecs execute-command/);
  });

  test('says why when no task can take a session', async () => {
    const { code, err, ran } = await runShell({}, { ecs: oneTask(ecsTask({ id: 't', agent: 'PENDING' })) });

    assert.equal(code, 1);
    assert.deepEqual(ran, []);
    assert.match(err, /No session possible on wp-x-example-test: no task can take a session \(t: the exec agent is PENDING\)/);
  });

  test('a missing service is an error', async () => {
    const { code, err } = await runShell({}, { ecs: { service: null } });

    assert.equal(code, 1);
    assert.match(err, /ECS has no service wp-x-wp-service-example-test/);
  });

  test('an ECS failure is reported with a credential hint', async () => {
    const { code, err } = await runShell({}, { ecs: { error: awsError('ExpiredToken', 'expired') } });

    assert.equal(code, 1);
    assert.match(err, /ExpiredToken: expired/);
    assert.match(err, /Check that AWS profile "example-nprd"/);
  });

  test('a missing AWS CLI gets an install hint', async () => {
    const runError = Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' });
    const { code, err } = await runShell({}, { runError });

    assert.equal(code, 1);
    assert.match(err, /AWS CLI \(aws\) isn't installed/);
    assert.match(err, /Session Manager plugin/);
  });
});
