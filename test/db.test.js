/**
 * Tests for `db tunnel` and `db password`. Nothing here opens a session or reads a real secret:
 * the session, the port check and the readiness wait are fakes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dbTunnelCommand, dbPasswordCommand } from '../lib/commands/db.js';
import {
  wordpressContext, contextBucket, fakeAws, awsError, ecsTask, ecsService, ecsTaskDefinition,
  taskDefinitionArn, mysqlGreeting, ACCOUNT,
} from './fixtures.js';

const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:wp/example-test-AbCdEf`;
const devContext = () => wordpressContext();
const prodContext = () => wordpressContext({ WORDPRESS: { env: { environmentType: 'production' } } });

/** AWS answers for a one-task service whose task definition carries the database settings. */
function healthyAws(context = devContext(), overrides = {}) {
  return fakeAws(
    { 'example-nprd': { buckets: { [contextBucket('wp-x-example-test')]: context } } },
    {
      service: ecsService(),
      tasks: [ecsTask({ id: 'task1' })],
      taskDefinitions: { [taskDefinitionArn(2)]: ecsTaskDefinition(), [taskDefinitionArn(1)]: ecsTaskDefinition({ dbHost: 'old-db.example.internal:3306' }) },
      secrets: { [SECRET_ARN]: '{"username":"root","password":"s3cret"}' },
      ...overrides,
    }
  );
}

/**
 * A fake session. `exit(code)` ends it; kill() ends it with 143. With `error`, it fails to start
 * the way spawn does, asynchronously.
 */
function fakeSession({ error } = {}) {
  let resolveExit, rejectExit;
  const exited = new Promise((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const child = {
    killedWith: null,
    stdin: { destroyed: false, destroy() { this.destroyed = true; } },
    kill(signal) {
      this.killedWith = signal;
      resolveExit(143);
    },
  };
  const start = (command, args, opts) => {
    start.call = { command, args, opts };
    if (error) {
      queueMicrotask(() => rejectExit(error));
    }
    return { child, exited };
  };
  start.call = null;
  return { start, child, exit: (code) => resolveExit(code) };
}

async function runTunnel(options = {}, {
  aws = healthyAws(), session = fakeSession(), portFree = true, wait,
} = {}) {
  let out = '';
  let err = '';
  // By default the tunnel becomes ready with a MySQL greeting, and closes right after (as if
  // someone pressed Ctrl-C), so the command finishes.
  const defaultWait = async () => {
    setImmediate(() => session.exit(0));
    return mysqlGreeting('8.0.44');
  };
  const code = await dbTunnelCommand('wp-x-example-test', options, {
    aws,
    env: {},
    readConfig: () => ({ config: { profiles: ['example-nprd'] }, files: [] }),
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    start: session.start,
    portFree: async () => portFree,
    wait: wait ?? defaultWait,
  });
  return { code, out, err, session };
}

describe('db tunnel', () => {
  test('opens the port forward through the picked task, reports MySQL, and how to connect', async () => {
    const { code, err, session } = await runTunnel();

    assert.equal(code, 0);
    const { command, args, opts } = session.start.call;
    assert.equal(command, 'aws');
    assert.deepEqual(args.slice(0, 2), ['ssm', 'start-session']);
    assert.equal(args[args.indexOf('--target') + 1], 'ecs:wp-x-wp-cluster-example-test_task1_task1-wordpress');
    assert.equal(args[args.indexOf('--parameters') + 1],
      '{"host":["db.example.internal"],"portNumber":["3306"],"localPortNumber":["13306"]}');
    assert.deepEqual(opts.stdio, ['pipe', 'inherit', 'inherit'], 'stdin is a pipe kept open');
    assert.match(err, /Opening a tunnel 127\.0\.0\.1:13306 -> db\.example\.internal:3306 through wp-x-example-test, task task1/);
    assert.match(err, /Connected: MySQL 8\.0\.44 answered through the tunnel/);
    assert.match(err, /user {6}root\n {2}database {2}wp_db\n {2}password {2}buwp-cloud db password wp-x-example-test/);
    assert.doesNotMatch(err, /s3cret/, 'the password never appears');
    assert.equal(session.child.stdin.destroyed, true, 'the stdin pipe is released when the tunnel closes');
  });

  test('--port changes the local port', async () => {
    const { session, err } = await runTunnel({ port: '13307' });

    const { args } = session.start.call;
    assert.match(args[args.indexOf('--parameters') + 1], /"localPortNumber":\["13307"\]/);
    assert.match(err, /127\.0\.0\.1:13307/);
  });

  test('rejects a --port that is not a port number', async () => {
    const { code, err, session } = await runTunnel({ port: 'abc' });

    assert.equal(code, 1);
    assert.equal(session.start.call, null);
    assert.match(err, /--port must be a port number, not "abc"/);
  });

  test('uses the database from the picked task\'s own task definition', async () => {
    const aws = healthyAws(devContext(), { tasks: [ecsTask({ id: 'old', revision: 1 })] });
    const { session } = await runTunnel({}, { aws });

    const { args } = session.start.call;
    assert.match(args[args.indexOf('--parameters') + 1], /"host":\["old-db\.example\.internal"\]/);
  });

  test('--print prints the command alone on stdout and opens nothing', async () => {
    const { code, out, err, session } = await runTunnel({ print: true });

    assert.equal(code, 0);
    assert.equal(session.start.call, null);
    assert.equal(out,
      'aws ssm start-session --target ecs:wp-x-wp-cluster-example-test_task1_task1-wordpress '
      + '--document-name AWS-StartPortForwardingSessionToRemoteHost '
      + `--parameters '{"host":["db.example.internal"],"portNumber":["3306"],"localPortNumber":["13306"]}' `
      + '--region us-east-1 --profile example-nprd\n');
    assert.match(err, /# 127\.0\.0\.1:13306 -> db\.example\.internal:3306 through wp-x-example-test/);
  });

  test('labels a production target before opening', async () => {
    const { code, err } = await runTunnel({}, { aws: healthyAws(prodContext()) });

    assert.equal(code, 0);
    assert.match(err, /PRODUCTION: wp-x-example-test .*\n.*Opening a tunnel/);
  });

  test('a busy local port is an error, with a suggestion', async () => {
    const { code, err, session } = await runTunnel({}, { portFree: false });

    assert.equal(code, 1);
    assert.equal(session.start.call, null);
    assert.match(err, /Local port 13306 is already in use/);
    assert.match(err, /--port 13307/);
  });

  test('warns when the remote end does not answer like MySQL, and keeps the tunnel', async () => {
    const session = fakeSession();
    const wait = async () => {
      setImmediate(() => session.exit(0));
      return null;
    };
    const { code, err } = await runTunnel({}, { session, wait });

    assert.equal(code, 0);
    assert.match(err, /the tunnel is open, but db\.example\.internal:3306 didn't answer like MySQL/);
    assert.match(err, /Connect a MySQL client/);
  });

  test('a tunnel that closes before it is ready is an error', async () => {
    const session = fakeSession();
    const wait = () => {
      session.exit(255);
      return new Promise(() => {});
    };
    const { code, err } = await runTunnel({}, { session, wait });

    assert.equal(code, 1);
    assert.match(err, /closed before it was ready/);
    assert.equal(session.child.killedWith, null);
  });

  test('a tunnel that never opens is stopped and reported', async () => {
    const session = fakeSession();
    const wait = async () => { throw new Error('The tunnel didn\'t open local port 13306 within 30s'); };
    const { code, err } = await runTunnel({}, { session, wait });

    assert.equal(code, 1);
    assert.equal(session.child.killedWith, 'SIGTERM');
    assert.match(err, /didn't open local port 13306/);
  });

  test('a missing AWS CLI gets an install hint', async () => {
    const session = fakeSession({ error: Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }) });
    const { code, err } = await runTunnel({}, { session, wait: () => new Promise(() => {}) });

    assert.equal(code, 1);
    assert.match(err, /AWS CLI \(aws\) isn't installed/);
  });

  test('says why when no task can take a tunnel', async () => {
    const aws = healthyAws(devContext(), { tasks: [] });
    const { code, err, session } = await runTunnel({}, { aws });

    assert.equal(code, 1);
    assert.equal(session.start.call, null);
    assert.match(err, /No tunnel possible on wp-x-example-test: the service has no running tasks/);
  });
});

describe('db password', () => {
  async function runPassword({ aws = healthyAws() } = {}) {
    let out = '';
    let err = '';
    const code = await dbPasswordCommand('wp-x-example-test', {}, {
      aws,
      env: {},
      readConfig: () => ({ config: { profiles: ['example-nprd'] }, files: [] }),
      stdout: (s) => { out += s; },
      stderr: (s) => { err += s; },
    });
    return { code, out, err };
  }

  test('prints only the password on stdout', async () => {
    const { code, out, err } = await runPassword();

    assert.equal(code, 0);
    assert.equal(out, 's3cret\n');
    assert.equal(err, '');
  });

  test('labels production on stderr, never on stdout', async () => {
    const { out, err } = await runPassword({ aws: healthyAws(prodContext()) });

    assert.equal(out, 's3cret\n');
    assert.match(err, /PRODUCTION/);
  });

  test('a task definition without the password secret is an error', async () => {
    const aws = healthyAws(devContext(), {
      taskDefinitions: { [taskDefinitionArn(2)]: ecsTaskDefinition({ passwordRef: null }) },
    });
    const { code, out, err } = await runPassword({ aws });

    assert.equal(code, 1);
    assert.equal(out, '');
    assert.match(err, /no WORDPRESS_DB_PASSWORD secret/);
  });

  test('a Secrets Manager failure is reported, with a credential hint when it is one', async () => {
    const denied = await runPassword({
      aws: healthyAws(devContext(), { secrets: { [SECRET_ARN]: awsError('AccessDeniedException', 'not allowed') } }),
    });
    assert.equal(denied.code, 1);
    assert.match(denied.err, /AccessDeniedException: not allowed/);
    assert.doesNotMatch(denied.err, /Check that AWS profile/);

    const expired = await runPassword({
      aws: healthyAws(devContext(), { secrets: { [SECRET_ARN]: awsError('ExpiredTokenException', 'expired') } }),
    });
    assert.match(expired.err, /Check that AWS profile "example-nprd"/);
  });
});
