/**
 * Tests for finding and reading a target's WordPress logs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  logConfigFromTaskDefinition, taskStreamName, grepPattern, parseTime, toLogEvent, fetchLogEvents,
  localTime, HEALTH_CHECK_PATH, isPassingHealthCheck, containerStreamPrefix, SESSION_STREAM_PREFIX,
} from '../lib/index.js';
import { ecsTaskDefinition, fakeAws, logEvent, LOG_GROUP } from './fixtures.js';

describe('logConfigFromTaskDefinition', () => {
  test('reads the wordpress container\'s awslogs settings, not the sidecar\'s listed first', () => {
    assert.deepEqual(logConfigFromTaskDefinition(ecsTaskDefinition()), {
      group: LOG_GROUP,
      region: 'us-east-1',
      streamPrefix: 'wp-x-wp',
    });
  });

  test('is null when the container doesn\'t log to CloudWatch', () => {
    assert.equal(logConfigFromTaskDefinition(ecsTaskDefinition({ logConfiguration: null })), null);
    assert.equal(logConfigFromTaskDefinition(ecsTaskDefinition({
      logConfiguration: { logDriver: 'splunk', options: {} },
    })), null);
    assert.equal(logConfigFromTaskDefinition(undefined), null);
  });
});

describe('taskStreamName', () => {
  test('is prefix/wordpress/task ID, from an ID or an ARN', () => {
    const config = { streamPrefix: 'wp-x-wp' };
    assert.equal(taskStreamName(config, 'abc123'), 'wp-x-wp/wordpress/abc123');
    assert.equal(taskStreamName(config, 'arn:aws:ecs:us-east-1:123456789012:task/c/abc123'), 'wp-x-wp/wordpress/abc123');
  });
});

describe('containerStreamPrefix', () => {
  test('covers every task\'s stream and stops short of the session transcripts', () => {
    const prefix = containerStreamPrefix({ streamPrefix: 'wp-x-wp' });
    assert.equal(prefix, 'wp-x-wp/wordpress/');
    assert.ok(taskStreamName({ streamPrefix: 'wp-x-wp' }, 'abc123').startsWith(prefix));
    assert.ok(!`${SESSION_STREAM_PREFIX}abc`.startsWith(prefix));
  });

  test('is null without a stream prefix, so nothing is filtered out', () => {
    assert.equal(containerStreamPrefix({ streamPrefix: null }), null);
  });
});

describe('grepPattern', () => {
  test('quotes the text as one term, escaping its double quotes', () => {
    assert.equal(grepPattern('PHP Fatal'), '"PHP Fatal"');
    assert.equal(grepPattern('"GET /healthcheck.htm'), '"\\"GET /healthcheck.htm"');
  });
});

describe('isPassingHealthCheck', () => {
  const line = (path, status) =>
    `10.1.0.1 - - [16/Nov/2026:13:55:56 -0500] "GET ${path} HTTP/1.1" ${status} 390 "-" "ELB-HealthChecker/2.0"`;

  test('matches the access-log line of a health check that returned 200', () => {
    assert.equal(HEALTH_CHECK_PATH, '/healthcheck.htm');
    assert.equal(isPassingHealthCheck({ message: line('/healthcheck.htm', 200) }), true);
  });

  test('leaves failing health checks, other requests and other messages alone', () => {
    assert.equal(isPassingHealthCheck({ message: line('/healthcheck.htm', 503) }), false);
    assert.equal(isPassingHealthCheck({ message: line('/healthcheck.htm', 2000) }), false);
    assert.equal(isPassingHealthCheck({ message: line('/news/', 200) }), false);
    assert.equal(isPassingHealthCheck({ message: 'PHP Fatal error: in /healthcheck.htm' }), false);
  });
});

describe('parseTime', () => {
  const now = Date.UTC(2026, 10, 16, 20, 0, 0);

  test('reads durations back from now', () => {
    assert.equal(parseTime('30s', { now }), now - 30_000);
    assert.equal(parseTime('15m', { now }), now - 15 * 60_000);
    assert.equal(parseTime('2h', { now }), now - 2 * 3_600_000);
    assert.equal(parseTime('3d', { now }), now - 3 * 86_400_000);
    assert.equal(parseTime('1w', { now }), now - 7 * 86_400_000);
  });

  test('reads a bare date as local midnight, and a time with a zone as written', () => {
    assert.equal(parseTime('2026-11-16', { now }), new Date(2026, 10, 16).getTime());
    assert.equal(parseTime('2026-11-16T11:15:00-05:00', { now }), Date.UTC(2026, 10, 16, 16, 15));
    assert.equal(parseTime('2026-11-16T11:15', { now }), new Date(2026, 10, 16, 11, 15).getTime());
  });

  test('rejects anything else, with the forms it takes', () => {
    assert.throws(() => parseTime('yesterday', { now }), /"yesterday" isn't a time\. Use a duration such as 15m/);
    assert.throws(() => parseTime('15 minutes', { now }), /isn't a time/);
  });
});

describe('toLogEvent', () => {
  test('takes the task ID from the stream and drops a trailing newline', () => {
    const e = toLogEvent(logEvent({ taskId: 'abc', timestamp: 5, message: 'line\n', eventId: 'e1' }));
    assert.deepEqual(e, { timestamp: 5, taskId: 'abc', session: null, stream: 'wp-x-wp/wordpress/abc', message: 'line', eventId: 'e1' });
  });

  test('takes the session ID from a transcript\'s stream, which names no task', () => {
    const e = toLogEvent({ ...logEvent(), logStreamName: `${SESSION_STREAM_PREFIX}s3ss10n` });
    assert.equal(e.taskId, null);
    assert.equal(e.session, 's3ss10n');
  });
});

describe('fetchLogEvents', () => {
  test('follows every page, empty ones included, and sorts by time', async () => {
    const pages = [
      { events: [logEvent({ taskId: 'b', timestamp: 30 })], nextToken: 't1' },
      { events: [], nextToken: 't2' },
      { events: [logEvent({ taskId: 'a', timestamp: 10 }), logEvent({ taskId: 'a', timestamp: 20 })] },
    ];
    const aws = fakeAws({}, { logs: (params, call) => pages[call] });

    const events = await fetchLogEvents(aws, 'example-nprd', 'us-east-1', {
      logGroupName: LOG_GROUP, startTime: 1, endTime: null, filterPattern: null,
    });

    assert.deepEqual(events.map((e) => [e.taskId, e.timestamp]), [['a', 10], ['a', 20], ['b', 30]]);
    const requests = aws.calls.filter(([name]) => name === 'filterLogEvents').map(([, , , p]) => p);
    assert.deepEqual(requests[0], { logGroupName: LOG_GROUP, startTime: 1 }, 'unset parameters are left out');
    assert.equal(requests[1].nextToken, 't1');
    assert.equal(requests[2].nextToken, 't2');
  });
});

describe('localTime', () => {
  test('formats local date and time to the second', () => {
    assert.equal(localTime(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03:04:05');
  });
});
