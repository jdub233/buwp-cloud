/**
 * logs: read a target's WordPress logs from CloudWatch.
 *
 * Web requests, WordPress cron and job-runner jobs all log to the group the task definition names,
 * one stream per task (bu-wp-cluster-ops, finding-the-logs.md). --task narrows to one task's stream,
 * including a job-runner task that has already stopped.
 *
 * ECS Exec session transcripts share the group (see logs.js), so a search keeps to the container's
 * streams by default, and --sessions searches the transcripts instead.
 *
 * Passing ALB health checks are most of the events in an unfiltered read, so they're hidden unless
 * --health-checks asks for them. They're dropped here rather than by the filter pattern, so hiding
 * works with any --filter-pattern syntax and the count of what was hidden can be reported.
 */

import chalk from 'chalk';
import { loadTarget, reportError, reportAwsError } from '../cli.js';
import {
  logConfigFromTaskDefinition, taskStreamName, containerStreamPrefix, grepPattern, parseTime,
  fetchLogEvents, localTime, isPassingHealthCheck, SESSION_STREAM_PREFIX,
} from '../logs.js';
import { taskIdFromArn } from '../tasks.js';
import { createAwsAdapter } from '../aws.js';

export const DEFAULT_SINCE = '10m';
export const FOLLOW_INTERVAL_MS = 2000;
// Events can be ingested a little after their timestamps, so each poll looks back this far and
// skips the events it has already shown.
export const FOLLOW_OVERLAP_MS = 30_000;
// FilterLogEvents is fine for minutes to hours; a 30-day scan of one group has taken over two
// minutes (finding-the-logs.md).
const SLOW_SPAN_MS = 6 * 3_600_000;

/**
 * @param {string} name - Target name, or its ECS cluster or service name
 * @param {{since?: string, until?: string, grep?: string, filterPattern?: string, task?: string,
 *   sessions?: boolean, healthChecks?: boolean, follow?: boolean, json?: boolean,
 *   profile?: string[]}} options
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code
 */
export default async function logsCommand(name, options = {}, {
  aws,
  env = process.env,
  readConfig,
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
  now = () => Date.now(),
  formatTime = localTime,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  keepFollowing = () => true,
} = {}) {
  if (options.grep !== undefined && options.filterPattern !== undefined) {
    return reportError(stderr, 'Use --grep or --filter-pattern, not both.');
  }
  if (options.sessions && options.task) {
    return reportError(stderr, "--sessions can't be combined with --task: a transcript's stream doesn't name its task.");
  }
  if (options.follow && (options.json || options.until)) {
    return reportError(stderr, `--follow can't be combined with ${options.json ? '--json' : '--until'}.`);
  }
  let start, end;
  try {
    start = parseTime(options.since ?? DEFAULT_SINCE, { now: now() });
    end = options.until === undefined ? null : parseTime(options.until, { now: now() });
  } catch (err) {
    return reportError(stderr, err.message);
  }
  if (end !== null && end <= start) {
    return reportError(stderr, '--until has to be later than --since.');
  }

  const adapter = aws ?? createAwsAdapter();
  const loaded = await loadTarget(name, options, { aws: adapter, env, readConfig, stderr });
  if (!loaded) {
    return 1;
  }
  const { target, source } = loaded;
  const reportAws = (err) => reportAwsError(stderr, err, { profile: target.profile, source });

  let config;
  try {
    const service = await adapter.describeService(target.profile, target.region, target.cluster, target.service);
    if (!service) {
      return reportError(stderr, `ECS has no service ${target.service} in ${target.cluster}.`);
    }
    const primary = service.deployments?.find((d) => d.status === 'PRIMARY');
    if (!primary) {
      return reportError(stderr, `${target.service} has no current deployment to read the log settings from.`);
    }
    config = logConfigFromTaskDefinition(
      await adapter.describeTaskDefinition(target.profile, target.region, primary.taskDefinition)
    );
  } catch (err) {
    return reportAws(err);
  }
  if (!config) {
    return reportError(stderr, `The wordpress container on ${target.name} doesn't log to CloudWatch (no awslogs settings).`);
  }

  const region = config.region ?? target.region;
  const filterPattern = options.grep !== undefined ? grepPattern(options.grep) : (options.filterPattern ?? null);
  let streams;
  if (options.sessions) {
    streams = SESSION_STREAM_PREFIX;
  } else if (options.task) {
    streams = taskStreamName(config, options.task);
  } else {
    streams = containerStreamPrefix(config);
  }
  const params = {
    logGroupName: config.group,
    logStreamNamePrefix: streams,
    filterPattern,
    startTime: start,
    endTime: end,
  };
  const fetch = (overrides = {}) => fetchLogEvents(adapter, target.profile, region, { ...params, ...overrides });

  const range = `since ${formatTime(start)}${end === null ? '' : ` until ${formatTime(end)}`}`;
  let scope = 'all tasks';
  if (options.sessions) {
    scope = 'ECS Exec session transcripts';
  } else if (options.task) {
    scope = `task ${taskIdFromArn(options.task)}`;
  }
  const line = (e) => `${chalk.gray(`${formatTime(e.timestamp)} ${(e.taskId ?? e.session).slice(0, 8)}`)} ${e.message}\n`;
  const shown = (e) => options.healthChecks || !isPassingHealthCheck(e);
  const healthChecks = (n) => `${n} passing health check${n === 1 ? '' : 's'}`;

  if (options.json) {
    let events;
    try {
      events = await fetch();
    } catch (err) {
      return reportAws(err);
    }
    const visible = events.filter(shown);
    stdout(`${JSON.stringify({
      target: target.name,
      logGroup: config.group,
      logStreamPrefix: streams,
      region,
      task: options.task ? taskIdFromArn(options.task) : null,
      filterPattern,
      start: new Date(start).toISOString(),
      end: end === null ? null : new Date(end).toISOString(),
      hiddenHealthChecks: events.length - visible.length,
      events: visible.map((e) => ({ ...e, timestamp: new Date(e.timestamp).toISOString() })),
    }, null, 2)}\n`);
    return 0;
  }

  const hiding = options.follow && !options.healthChecks ? ', passing health checks hidden' : '';
  stderr(chalk.gray(`${target.name}: ${config.group}, ${scope}, ${range}`
    + `${filterPattern ? `, matching ${filterPattern}` : ''}${hiding}.\n`));
  if (!options.follow && (end ?? now()) - start > SLOW_SPAN_MS) {
    stderr(chalk.gray('A search this long can take minutes. A narrower --since or --until is faster.\n'));
  }

  if (!options.follow) {
    let events;
    try {
      events = await fetch();
    } catch (err) {
      return reportAws(err);
    }
    const visible = events.filter(shown);
    const hidden = events.length - visible.length;
    visible.forEach((e) => stdout(line(e)));
    if (!visible.length) {
      stderr(chalk.gray(hidden
        ? `No log events besides ${healthChecks(hidden)} (--health-checks shows them).\n`
        : 'No log events.\n'));
    } else if (hidden) {
      stderr(chalk.gray(`Hid ${healthChecks(hidden)} (--health-checks shows them).\n`));
    }
    return 0;
  }

  // Follow: show what's there, then poll for more until interrupted. Each poll starts a little
  // before the previous one ran, so the window stays short whether or not anything matched.
  const seen = new Map();
  const show = (events, from) => {
    for (const e of events.filter(shown)) {
      if (!seen.has(e.eventId)) {
        seen.set(e.eventId, e.timestamp);
        stdout(line(e));
      }
    }
    // Nothing older than this poll's start can come back, so its IDs needn't be kept.
    for (const [id, timestamp] of seen) {
      if (timestamp < from) {
        seen.delete(id);
      }
    }
  };
  try {
    let polledAt = now();
    show(await fetch(), start);
    while (keepFollowing()) {
      await sleep(FOLLOW_INTERVAL_MS);
      const from = Math.max(start, polledAt - FOLLOW_OVERLAP_MS);
      polledAt = now();
      show(await fetch({ startTime: from }), from);
    }
  } catch (err) {
    return reportAws(err);
  }
  return 0;
}
