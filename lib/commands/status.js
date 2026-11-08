/**
 * status: the state of one target's WordPress service, and which task a session would use.
 */

import chalk from 'chalk';
import { loadConfig, resolveProfiles } from '../config.js';
import { findTarget, TargetError } from '../targets.js';
import {
  WORDPRESS_CONTAINER, summarizeTask, pickTask, execBlocker, taskDefinitionLabel,
} from '../tasks.js';
import { credentialHint, describeError, errorCode } from '../errors.js';
import { createAwsAdapter } from '../aws.js';
import { formatTable, formatDuration, formatJobRunner } from '../format.js';

/**
 * Read a target's service, deployments, tasks and current image.
 * @param {object} target - From findTarget()
 * @param {object} aws - The AWS adapter
 * @returns {Promise<object>} JSON-ready status. `service` is null when ECS has no such service.
 */
export async function gatherStatus(target, aws) {
  const { profile, region, cluster, service: serviceName } = target;
  const service = await aws.describeService(profile, region, cluster, serviceName);
  if (!service) {
    return {
      target, service: null, image: null, tasks: [],
      pick: { taskId: null, reason: `ECS has no service ${serviceName} in ${cluster}` },
    };
  }

  const primary = service.deployments?.find((d) => d.status === 'PRIMARY');
  const [taskArns, taskDefinition] = await Promise.all([
    aws.listServiceTasks(profile, region, cluster, serviceName),
    primary ? aws.describeTaskDefinition(profile, region, primary.taskDefinition) : null,
  ]);
  const tasks = (await aws.describeTasks(profile, region, cluster, taskArns)).map(summarizeTask);
  const pick = pickTask(tasks, { primaryTaskDefinitionArn: primary?.taskDefinition ?? null });

  return {
    target,
    service: {
      name: service.serviceName,
      status: service.status,
      desiredCount: service.desiredCount,
      runningCount: service.runningCount,
      pendingCount: service.pendingCount,
      execEnabled: service.enableExecuteCommand === true,
      deployments: (service.deployments ?? []).map((d) => ({
        status: d.status,
        rolloutState: d.rolloutState ?? null,
        taskDefinition: taskDefinitionLabel(d.taskDefinition),
        desiredCount: d.desiredCount,
        runningCount: d.runningCount,
        pendingCount: d.pendingCount,
        failedTasks: d.failedTasks ?? 0,
      })),
    },
    image: taskDefinition?.containerDefinitions?.find((c) => c.name === WORDPRESS_CONTAINER)?.image ?? null,
    tasks: tasks.map((t) => ({ ...t, blocker: execBlocker(t) })),
    pick: { taskId: pick.task?.taskId ?? null, reason: pick.reason },
  };
}

/**
 * Render a gathered status for a terminal.
 * @param {object} status - From gatherStatus()
 * @param {{now?: Date, paintProd?: (s: string) => string}} options
 * @returns {string}
 */
export function formatStatus(status, { now = new Date(), paintProd = (s) => s } = {}) {
  const { target, service, image, tasks, pick } = status;
  const environment = target.environmentType ?? 'unset';
  const prod = target.production
    ? `  ${paintProd(target.environmentType === 'production' ? 'PROD' : 'PROD (environmentType unset or unknown)')}`
    : '';

  const fields = [
    ['Target', `${target.name} (${environment})${prod}`],
    ['Profile', `${target.profile ?? '(default)'}, ${target.region}`],
    ['Cluster', target.cluster],
  ];
  if (!service) {
    fields.push(['Service', `${target.service}: not found`]);
    return [formatFields(fields), '', pick.reason].join('\n');
  }

  fields.push(['Service', `${service.name}: ${service.status}, `
    + `${service.runningCount} running of ${service.desiredCount} desired`
    + `${service.pendingCount ? `, ${service.pendingCount} pending` : ''}`]);
  service.deployments.forEach((d, i) => {
    fields.push([i ? '' : 'Deployments', `${d.status} ${d.taskDefinition}, `
      + `rollout ${d.rolloutState ?? 'unknown'}, ${d.runningCount} running of ${d.desiredCount}`
      + `${d.failedTasks ? `, ${d.failedTasks} failed` : ''}`]);
  });
  fields.push(['Image', image ?? '-']);
  fields.push(['Job runner', formatJobRunner(target.jobRunner)]);

  const lines = [formatFields(fields), ''];
  if (tasks.length) {
    const rows = tasks.map((t) => [
      t.taskId,
      t.startedAt ? formatDuration(now - new Date(t.startedAt)) : '-',
      t.taskDefinition ?? '-',
      t.blocker ? `no: ${t.blocker}` : 'ready',
      t.taskId === pick.taskId ? '<- sessions use this' : '',
    ]);
    lines.push(formatTable(['TASK', 'UP', 'TASK DEF', 'EXEC', ''], rows), '');
  }
  lines.push(pick.taskId ? `Sessions will use task ${pick.taskId}: ${pick.reason}.` : `No session possible: ${pick.reason}.`);
  return lines.join('\n');
}

function formatFields(fields) {
  const width = Math.max(...fields.map(([label]) => label.length));
  return fields.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

/**
 * @param {string} name - Target name, or its ECS cluster or service name
 * @param {{profile?: string[], json?: boolean}} options
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code
 */
export default async function statusCommand(name, options = {}, {
  aws,
  env = process.env,
  readConfig = () => loadConfig({ env }),
  now = () => new Date(),
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
} = {}) {
  const fail = (message, hint) => {
    stderr(`${chalk.red('Error:')} ${message}\n`);
    if (hint) {
      stderr(`  ${hint}\n`);
    }
    return 1;
  };

  let profiles, source;
  try {
    ({ profiles, source } = resolveProfiles({ cliProfiles: options.profile ?? [], env, readConfig }));
  } catch (err) {
    return fail(describeError(err));
  }

  const adapter = aws ?? createAwsAdapter();
  let target;
  try {
    ({ target } = await findTarget(name, { profiles, source, aws: adapter }));
  } catch (err) {
    if (!(err instanceof TargetError)) {
      return fail(describeError(err));
    }
    stderr(`${chalk.red('Error:')} ${err.message}\n`);
    if (err.suggestions.length) {
      stderr(`  Targets: ${err.suggestions.join(', ')}\n`);
    }
    for (const e of err.errors.filter((e) => !e.bucket)) {
      stderr(`  Couldn't search ${e.profile ?? '(default)'}: ${e.message}\n`);
      const hint = credentialHint(e, { source });
      if (hint) {
        stderr(`  ${hint}\n`);
      }
    }
    return 1;
  }

  let status;
  try {
    status = await gatherStatus(target, adapter);
  } catch (err) {
    return fail(describeError(err), credentialHint({ code: errorCode(err), profile: target.profile }, { source }));
  }

  if (options.json) {
    stdout(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    stdout(`${formatStatus(status, { now: now(), paintProd: chalk.red })}\n`);
  }
  return 0;
}
