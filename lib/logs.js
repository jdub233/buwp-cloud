/**
 * Logs: where a target's WordPress logs live, and reading them.
 *
 * The task definition's logConfiguration names the log group exactly, so there's no searching by
 * prefix (finding-the-logs.md looks for the stack prefix plus "wplogs"). Every task started from the
 * definition logs there, web tasks and job-runner tasks alike, each to its own stream named
 * `<stream prefix>/wordpress/<task ID>`. PHP errors and Apache's access log share that stream.
 *
 * ECS Exec sessions log to the same group. No cluster sets executeCommandConfiguration, so ECS's
 * default applies, and each session's transcript (what it printed, not the command it was given)
 * becomes its own `ecs-execute-command-<session ID>` stream. Searches keep to the container's
 * streams unless they ask for the transcripts.
 */

import { WORDPRESS_CONTAINER, taskIdFromArn } from './tasks.js';

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// The path the ALB's target group checks (bu-wp-ecs lib/Wordpress.ts, `this.healthcheck`). The
// container's own ECS health check is `echo hello` and never reaches Apache, so these access-log
// lines all come from the ALB, from each of its nodes, every few seconds.
export const HEALTH_CHECK_PATH = '/healthcheck.htm';
const PASSING_HEALTH_CHECK = `"GET ${HEALTH_CHECK_PATH} HTTP/1.1" 200 `;

/**
 * Whether an event is Apache's access-log line for a health check that passed. A failing one isn't,
 * so it still shows.
 * @param {{message: string}} event
 * @returns {boolean}
 */
export function isPassingHealthCheck(event) {
  return event.message.includes(PASSING_HEALTH_CHECK);
}

/**
 * Where the wordpress container's logs go.
 * @param {object} taskDefinition - From DescribeTaskDefinition
 * @returns {{group: string, region: string|null, streamPrefix: string|null}|null} null when the
 *   container doesn't log to CloudWatch
 */
export function logConfigFromTaskDefinition(taskDefinition) {
  const container = taskDefinition?.containerDefinitions?.find((c) => c.name === WORDPRESS_CONTAINER);
  const log = container?.logConfiguration;
  const options = log?.options ?? {};
  if (log?.logDriver !== 'awslogs' || !options['awslogs-group']) {
    return null;
  }
  return {
    group: options['awslogs-group'],
    region: options['awslogs-region'] ?? null,
    streamPrefix: options['awslogs-stream-prefix'] ?? null,
  };
}

/**
 * The stream a task's wordpress container writes to.
 * @param {{streamPrefix: string|null}} config
 * @param {string} task - Task ID or ARN
 * @returns {string}
 */
export function taskStreamName(config, task) {
  return [config.streamPrefix, WORDPRESS_CONTAINER, taskIdFromArn(task)].filter(Boolean).join('/');
}

/** The start of every ECS Exec session transcript's stream name. */
export const SESSION_STREAM_PREFIX = 'ecs-execute-command-';

/**
 * The start of every stream the wordpress container writes, web and job-runner tasks alike, which
 * leaves out the session transcripts. Null without a stream prefix (Fargate requires one), since
 * the streams then can't be told apart by name.
 * @param {{streamPrefix: string|null}} config
 * @returns {string|null}
 */
export function containerStreamPrefix(config) {
  return config.streamPrefix ? `${config.streamPrefix}/${WORDPRESS_CONTAINER}/` : null;
}

/**
 * A CloudWatch filter pattern that matches the text as written: a quoted term matches it anywhere in
 * the message, case-sensitively, and \" stands for a double quote inside one.
 * @param {string} text
 * @returns {string}
 */
export function grepPattern(text) {
  return `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * A point in time from --since or --until: a duration back from now (30s, 15m, 2h, 3d, 1w), a date
 * (local midnight), or a date and time (local unless it names a zone).
 * @param {string} value
 * @param {{now: number}} opts
 * @returns {number} Epoch milliseconds
 */
export function parseTime(value, { now }) {
  const text = String(value).trim();
  const duration = text.match(/^(\d+)([smhdw])$/);
  if (duration) {
    return now - Number(duration[1]) * UNITS[duration[2]];
  }
  const date = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (date) {
    // Date.parse reads a bare date as UTC midnight; local midnight is what people mean.
    return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime();
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`"${value}" isn't a time. Use a duration such as 15m, 2h or 3d, `
      + 'or a date and time such as 2026-11-16T14:30.');
  }
  return parsed;
}

/**
 * A log event as buwp-cloud reports it.
 * @param {object} event - From FilterLogEvents
 * @returns {{timestamp: number, taskId: string|null, session: string|null, stream: string,
 *   message: string, eventId: string}} taskId for a container's stream, session for a transcript's
 */
export function toLogEvent(event) {
  const stream = event.logStreamName ?? '';
  const session = stream.startsWith(SESSION_STREAM_PREFIX) ? stream.slice(SESSION_STREAM_PREFIX.length) : null;
  return {
    timestamp: event.timestamp,
    taskId: session === null ? taskIdFromArn(stream) : null,
    session,
    stream: event.logStreamName ?? null,
    message: String(event.message ?? '').replace(/\r?\n$/, ''),
    eventId: event.eventId ?? null,
  };
}

/**
 * Every event that matches, across all pages, oldest first.
 * @param {object} aws - The AWS adapter
 * @param {string|null} profile
 * @param {string} region
 * @param {{logGroupName: string, startTime: number, endTime?: number|null,
 *   filterPattern?: string|null, logStreamNamePrefix?: string|null}} params
 * @returns {Promise<object[]>} From toLogEvent()
 */
export async function fetchLogEvents(aws, profile, region, params) {
  const request = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined));
  const events = [];
  let nextToken = null;
  do {
    const page = await aws.filterLogEvents(profile, region, { ...request, ...(nextToken ? { nextToken } : {}) });
    events.push(...page.events.map(toLogEvent));
    nextToken = page.nextToken;
  } while (nextToken);
  // Events from several streams can arrive interleaved; the sort is stable, so ties keep their order.
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

/** Local date and time to the second, as YYYY-MM-DD HH:MM:SS. */
export function localTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
