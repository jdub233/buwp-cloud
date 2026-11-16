/**
 * Tests for the exec command. Nothing here opens a session: `start` is a fake that plays back what
 * a session would print.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import execCommand, { NO_STATUS_EXIT_CODE } from '../lib/commands/exec.js';
import {
  wordpressContext, contextBucket, fakeAws, ecsTask, ecsService,
} from './fixtures.js';

const NONCE = '__buwp_0123456789ab_';
const devContext = () => wordpressContext();
const prodContext = () => wordpressContext({ WORDPRESS: { env: { environmentType: 'production' } } });
const oneTask = (service = ecsService()) => ({ service, tasks: [ecsTask({ id: 'task1' })] });

/** What the container sends back for a command that prints `out`, warns `err` and exits `status`. */
const reply = ({ status = 0 } = {}) =>
  `Starting session with SessionId: example\n${NONCE}BEGIN\r\nout\r\n${NONCE}E err\r\n\r\n${NONCE}RC=${status}\r\n\nExiting session.\n`;

/** A fake startSession: records the call, prints `output` on the child's stdout, exits `awsExit`. */
function fakeStart({ output = reply(), awsExit = 0, error } = {}) {
  const started = [];
  const start = (command, args, opts) => {
    started.push({ command, args, opts });
    const child = { stdout: new PassThrough(), stdin: new PassThrough() };
    const exited = new Promise((resolve, reject) => {
      setImmediate(() => {
        if (error) {
          reject(error);
          return;
        }
        child.stdout.end(output);
        child.stdout.on('end', () => resolve(awsExit));
        child.stdout.resume();
      });
    });
    return { child, exited };
  };
  return { start, started };
}

async function runExec(words, options = {}, {
  context = devContext(), ecs = oneTask(), terminal = false, session = fakeStart(),
} = {}) {
  let out = '';
  let err = '';
  const code = await execCommand('wp-x-example-test', words, options, {
    aws: fakeAws({ 'example-nprd': { buckets: { [contextBucket('wp-x-example-test')]: context } } }, ecs),
    env: {},
    readConfig: () => ({ config: { profiles: ['example-nprd'] }, files: [] }),
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    stdoutIsTerminal: () => terminal,
    start: session.start,
    nonce: () => NONCE,
  });
  return { code, out, err, started: session.started };
}

/** The script a recorded call sent, decoded. */
function sentScript(call) {
  const command = call.args[call.args.indexOf('--command') + 1];
  return Buffer.from(command.match(/^sh -c "echo (\S+) \| base64 -d \| sh"/)[1], 'base64').toString('utf8');
}

describe('exec', () => {
  test('runs the command in the picked task\'s wordpress container and returns its exit status', async () => {
    const session = fakeStart({ output: reply({ status: 4 }) });
    const { code, out, err, started } = await runExec(['wp', 'option', 'get', 'home'], {}, { session });

    assert.equal(code, 4);
    assert.equal(out, 'out\n');
    assert.match(err, /Running in wp-x-example-test, task task1 \(oldest ready task on the current deployment\)\.\nerr\n$/);
    const [{ command, args, opts }] = started;
    assert.equal(command, 'aws');
    assert.equal(args[args.indexOf('--task') + 1], 'task1');
    assert.equal(args[args.indexOf('--container') + 1], 'wordpress');
    assert.equal(args[args.indexOf('--profile') + 1], 'example-nprd');
    assert.match(args[args.indexOf('--command') + 1], / buwp:wp-option-get$/);
    assert.match(sentScript(started[0]), /^rc=\$\( \{ \{ wp option get home <\/dev\/null /m);
    assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'inherit'], 'stdin stays an open pipe');
  });

  test('tells wp-cli it is piped when output here is, and not when it is a terminal', async () => {
    const piped = await runExec(['wp', 'plugin', 'list'], {}, { terminal: false });
    const terminal = await runExec(['wp', 'plugin', 'list'], {}, { terminal: true });

    assert.match(sentScript(piped.started[0]), /^export SHELL_PIPE=1$/m);
    assert.doesNotMatch(sentScript(terminal.started[0]), /SHELL_PIPE/);
  });

  test('--task pins the task', async () => {
    const ecs = { service: ecsService(), tasks: [ecsTask({ id: 'a' }), ecsTask({ id: 'b', startedAt: '2027-01-01T00:00:00Z' })] };
    const { started } = await runExec(['wp'], { task: 'b' }, { ecs });

    assert.equal(started[0].args[started[0].args.indexOf('--task') + 1], 'b');
  });

  test('nothing to run is an error, before any AWS call', async () => {
    const { code, err, started } = await runExec([]);

    assert.equal(code, 1);
    assert.match(err, /Nothing to run/);
    assert.deepEqual(started, []);
  });

  test('--print shows the readable script and the aws command, and runs nothing', async () => {
    const { code, out, err, started } = await runExec(['wp', 'option', 'get', 'home'], { print: true });

    assert.equal(code, 0);
    assert.deepEqual(started, []);
    assert.match(out, /^script=\$\(cat <<'BUWP_SCRIPT'\nexport PAGER=cat\nwp option get home <\/dev\/null\n/);
    assert.match(out, /\naws ecs execute-command --cluster wp-x-wp-cluster-example-test --task task1 /);
    assert.doesNotMatch(out, /SHELL_PIPE/, 'composed for the terminal a person will paste it into');
    assert.match(err, /# wp-x-example-test, task task1/);
  });

  test('labels production before running, and on stderr only with --print', async () => {
    const run = await runExec(['wp'], {}, { context: prodContext() });
    assert.match(run.err, /^PRODUCTION: wp-x-example-test \(environmentType production; profile example-nprd\)\n/);
    assert.equal(run.started.length, 1);

    const print = await runExec(['wp'], { print: true }, { context: prodContext() });
    assert.doesNotMatch(print.out, /PRODUCTION/);
    assert.match(print.err, /PRODUCTION: wp-x-example-test/);
  });

  test('warns when the service runs a single task, and not otherwise', async () => {
    const single = await runExec(['wp'], {}, { ecs: oneTask(ecsService({ desired: 1 })) });
    assert.match(single.err, /Note: wp-x-wp-service-example-test runs a single task, so a session that runs it out of memory takes the site down with it\./);

    const two = await runExec(['wp'], {}, { ecs: oneTask(ecsService({ desired: 2, running: 2 })) });
    assert.doesNotMatch(two.err, /single task/);
  });

  test('a session that never reached the command passes on what it said, and fails', async () => {
    const session = fakeStart({ output: '\nCannot perform start session: EOF\n', awsExit: 255 });
    const { code, err } = await runExec(['wp'], {}, { session });

    assert.equal(code, 255);
    assert.match(err, /Cannot perform start session: EOF\n/);
    assert.match(err, /The session ended before the command started \(aws exited 255\)/);
  });

  test('a session cut off mid-command exits 255, saying the status is unknown', async () => {
    const session = fakeStart({ output: `${NONCE}BEGIN\r\nhalf\r\n` });
    const { code, out, err } = await runExec(['wp'], {}, { session });

    assert.equal(code, NO_STATUS_EXIT_CODE);
    assert.equal(out, 'half\n');
    assert.match(err, /exit status is unknown/);
    assert.match(err, /Check before running it again/);
  });

  test('a missing AWS CLI gets an install hint', async () => {
    const session = fakeStart({ error: Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }) });
    const { code, err } = await runExec(['wp'], {}, { session });

    assert.equal(code, 1);
    assert.match(err, /AWS CLI \(aws\) isn't installed/);
  });

  test('says why when no task can take a session', async () => {
    const ecs = { service: ecsService(), tasks: [ecsTask({ id: 't', agent: 'PENDING' })] };
    const { code, err, started } = await runExec(['wp'], {}, { ecs });

    assert.equal(code, 1);
    assert.deepEqual(started, []);
    assert.match(err, /No session possible on wp-x-example-test: no task can take a session/);
  });
});
