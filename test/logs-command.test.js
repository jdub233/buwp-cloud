/**
 * Tests for the logs command.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import logsCommand, { FOLLOW_INTERVAL_MS, FOLLOW_OVERLAP_MS } from '../lib/commands/logs.js';
import {
  wordpressContext, contextBucket, fakeAws, awsError, ecsService, ecsTaskDefinition,
  taskDefinitionArn, logEvent, LOG_GROUP,
} from './fixtures.js';

const NOW = Date.UTC(2026, 0, 1, 5, 30, 0);
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Apache access-log lines, as they reach CloudWatch. */
const access = (path, status, agent = 'Mozilla/5.0') =>
  `10.0.0.1 - - [01/Jan/2026:00:29:00 -0500] "GET ${path} HTTP/1.1" ${status} 390 "-" "${agent}"`;
const healthCheck = (status = 200) => access('/healthcheck.htm', status, 'ELB-HealthChecker/2.0');

/** ECS and CloudWatch answers: a service on revision 2, and `logs` for filterLogEvents. */
const answers = (logs = () => ({ events: [] }), td = ecsTaskDefinition()) => ({
  service: ecsService(),
  taskDefinitions: { [taskDefinitionArn(2)]: td },
  logs,
});

async function runLogs(options = {}, ecs = answers(), { now = () => NOW, keepFollowing, sleep } = {}) {
  let out = '';
  let err = '';
  const aws = fakeAws({ 'example-nprd': { buckets: { [contextBucket('wp-x-example-test')]: wordpressContext() } } }, ecs);
  const code = await logsCommand('wp-x-example-test', options, {
    aws,
    env: {},
    readConfig: () => ({ config: { profiles: ['example-nprd'] }, files: [] }),
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    now,
    formatTime: utc,
    sleep: sleep ?? (async () => {}),
    keepFollowing: keepFollowing ?? (() => false),
  });
  const requests = aws.calls.filter(([name]) => name === 'filterLogEvents').map(([, profile, region, p]) => ({ profile, region, ...p }));
  return { code, out, err, requests };
}

describe('logs', () => {
  test('reads the group the task definition names, for the last 10 minutes by default', async () => {
    const events = [logEvent({ taskId: 'abcdef0123', timestamp: NOW - 60_000, message: 'PHP Warning: example' })];
    const { code, out, err, requests } = await runLogs({}, answers(() => ({ events })));

    assert.equal(code, 0);
    assert.equal(out, '2026-01-01 05:29:00 abcdef01 PHP Warning: example\n');
    assert.match(err, new RegExp(`^wp-x-example-test: ${LOG_GROUP}, all tasks, since 2026-01-01 05:20:00\\.\n$`));
    assert.deepEqual(requests, [{
      profile: 'example-nprd',
      region: 'us-east-1',
      logGroupName: LOG_GROUP,
      logStreamNamePrefix: 'wp-x-wp/wordpress/',
      startTime: NOW - 600_000,
    }]);
  });

  test('--sessions searches the ECS Exec transcripts instead, labeled by session', async () => {
    const transcript = { ...logEvent({ timestamp: NOW - 60_000, message: 'Script started on …' }), logStreamName: 'ecs-execute-command-s3ss10nid' };
    const { code, out, err, requests } = await runLogs({ sessions: true, grep: 'wp option' }, answers(() => ({ events: [transcript] })));

    assert.equal(code, 0);
    assert.equal(requests[0].logStreamNamePrefix, 'ecs-execute-command-');
    assert.equal(requests[0].filterPattern, '"wp option"');
    assert.equal(out, '2026-01-01 05:29:00 s3ss10ni Script started on …\n');
    assert.match(err, /, ECS Exec session transcripts, since /);
  });

  test('--since, --until, --grep and --task narrow the search', async () => {
    const { requests, err } = await runLogs({
      since: '2h', until: '1h', grep: 'PHP Fatal', task: 'arn:aws:ecs:us-east-1:123456789012:task/c/abc123',
    });

    assert.deepEqual(requests[0], {
      profile: 'example-nprd',
      region: 'us-east-1',
      logGroupName: LOG_GROUP,
      logStreamNamePrefix: 'wp-x-wp/wordpress/abc123',
      filterPattern: '"PHP Fatal"',
      startTime: NOW - 2 * 3_600_000,
      endTime: NOW - 3_600_000,
    });
    assert.match(err, /task abc123, since 2026-01-01 03:30:00 until 2026-01-01 04:30:00, matching "PHP Fatal"\./);
  });

  test('--filter-pattern passes CloudWatch syntax through', async () => {
    const { requests } = await runLogs({ filterPattern: '?Fatal ?Warning' });

    assert.equal(requests[0].filterPattern, '?Fatal ?Warning');
  });

  test('says so when nothing matched', async () => {
    const { code, out, err } = await runLogs({ grep: 'nothing' });

    assert.equal(code, 0);
    assert.equal(out, '');
    assert.match(err, /No log events\.\n$/);
  });

  test('warns that a long search can be slow', async () => {
    assert.match((await runLogs({ since: '3d' })).err, /A search this long can take minutes/);
    assert.doesNotMatch((await runLogs({ since: '2h' })).err, /can take minutes/);
  });

  test('--json prints the search and its events', async () => {
    const events = [logEvent({ taskId: 'abc', timestamp: NOW - 1000, message: 'hello', eventId: 'e1' })];
    const { out, err } = await runLogs({ json: true, grep: 'hello' }, answers(() => ({ events })));

    assert.deepEqual(JSON.parse(out), {
      target: 'wp-x-example-test',
      logGroup: LOG_GROUP,
      logStreamPrefix: 'wp-x-wp/wordpress/',
      region: 'us-east-1',
      task: null,
      filterPattern: '"hello"',
      start: new Date(NOW - 600_000).toISOString(),
      end: null,
      hiddenHealthChecks: 0,
      events: [{
        timestamp: new Date(NOW - 1000).toISOString(),
        taskId: 'abc',
        session: null,
        stream: 'wp-x-wp/wordpress/abc',
        message: 'hello',
        eventId: 'e1',
      }],
    });
    assert.equal(err, '');
  });

  describe('health checks', () => {
    const mixed = () => answers(() => ({
      events: [
        logEvent({ eventId: 'h1', timestamp: NOW - 3000, message: healthCheck() }),
        logEvent({ eventId: 'r1', timestamp: NOW - 2000, message: access('/news/', 200) }),
        logEvent({ eventId: 'h2', timestamp: NOW - 1000, message: healthCheck(503) }),
        logEvent({ eventId: 'h3', timestamp: NOW - 500, message: healthCheck() }),
      ],
    }));
    const shownPaths = (out) => out.split('\n').filter(Boolean).map((l) => l.match(/"GET (\S+) HTTP\/1\.1" (\d+)/).slice(1).join(' '));

    test('passing ones are hidden and counted; a failing one still shows', async () => {
      const { out, err } = await runLogs({}, mixed());

      assert.deepEqual(shownPaths(out), ['/news/ 200', '/healthcheck.htm 503']);
      assert.match(err, /Hid 2 passing health checks \(--health-checks shows them\)\.\n$/);
    });

    test('--health-checks shows them all', async () => {
      const { out, err } = await runLogs({ healthChecks: true }, mixed());

      assert.equal(shownPaths(out).length, 4);
      assert.doesNotMatch(err, /Hid/);
    });

    test('a window of nothing but health checks says what it hid', async () => {
      const onlyChecks = answers(() => ({ events: [logEvent({ message: healthCheck() })] }));
      const { out, err } = await runLogs({}, onlyChecks);

      assert.equal(out, '');
      assert.match(err, /No log events besides 1 passing health check \(--health-checks shows them\)\.\n$/);
    });

    test('--json leaves them out and counts them', async () => {
      const parsed = JSON.parse((await runLogs({ json: true }, mixed())).out);

      assert.equal(parsed.hiddenHealthChecks, 2);
      assert.deepEqual(parsed.events.map((e) => e.eventId), ['r1', 'h2']);
    });

    test('--follow hides them, and says so up front', async () => {
      const { out, err } = await runLogs({ follow: true }, mixed());

      assert.deepEqual(shownPaths(out), ['/news/ 200', '/healthcheck.htm 503']);
      assert.match(err, /, passing health checks hidden\.\n/);
    });
  });

  test('--follow prints new events once each, polling from just before the last poll', async () => {
    let clock = NOW;
    const polls = [
      { events: [logEvent({ eventId: 'a', timestamp: NOW - 5000, message: 'first' })] },
      { events: [logEvent({ eventId: 'a', timestamp: NOW - 5000, message: 'first' }),
        logEvent({ eventId: 'b', timestamp: NOW + 1000, message: 'second' })] },
      { events: [] },
    ];
    let rounds = 0;
    const { code, out, requests } = await runLogs({ follow: true }, answers((p, call) => polls[call]), {
      now: () => clock,
      sleep: async (ms) => { assert.equal(ms, FOLLOW_INTERVAL_MS); clock += ms; },
      keepFollowing: () => rounds++ < 2,
    });

    assert.equal(code, 0);
    assert.deepEqual(out.split('\n').filter(Boolean).map((l) => l.split(' ').pop()), ['first', 'second']);
    assert.deepEqual(requests.map((r) => r.startTime), [
      NOW - 600_000,
      NOW - FOLLOW_OVERLAP_MS,
      NOW + FOLLOW_INTERVAL_MS - FOLLOW_OVERLAP_MS,
    ]);
  });

  test('rejects option combinations and times it can\'t use, before any AWS call', async () => {
    const cases = [
      [{ grep: 'a', filterPattern: 'b' }, /Use --grep or --filter-pattern, not both/],
      [{ sessions: true, task: 'abc' }, /--sessions can't be combined with --task/],
      [{ follow: true, json: true }, /--follow can't be combined with --json/],
      [{ follow: true, until: '1h' }, /--follow can't be combined with --until/],
      [{ since: 'yesterday' }, /"yesterday" isn't a time/],
      [{ since: '1h', until: '2h' }, /--until has to be later than --since/],
    ];
    for (const [options, message] of cases) {
      const { code, err, requests } = await runLogs(options);
      assert.equal(code, 1);
      assert.match(err, message);
      assert.deepEqual(requests, []);
    }
  });

  test('a container without CloudWatch logging is an error', async () => {
    const { code, err } = await runLogs({}, answers(undefined, ecsTaskDefinition({ logConfiguration: null })));

    assert.equal(code, 1);
    assert.match(err, /doesn't log to CloudWatch/);
  });

  test('a CloudWatch failure is reported with a credential hint', async () => {
    const { code, err } = await runLogs({}, answers(() => { throw awsError('ExpiredTokenException', 'expired'); }));

    assert.equal(code, 1);
    assert.match(err, /ExpiredTokenException: expired/);
    assert.match(err, /Check that AWS profile "example-nprd"/);
  });
});
