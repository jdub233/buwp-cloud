/**
 * status: the state of one target's WordPress service, and which task a session would use.
 */

import chalk from 'chalk';
import { loadTarget, reportAwsError } from '../cli.js';
import {
  WORDPRESS_CONTAINER, loadServiceTasks, pickTask, execBlocker, taskDefinitionLabel,
} from '../tasks.js';
import { createAwsAdapter } from '../aws.js';
import { formatTable, formatDuration, formatJobRunner } from '../format.js';

/**
 * Read a target's service, deployments, tasks and current image.
 * @param {object} target - From findTarget()
 * @param {object} aws - The AWS adapter
 * @returns {Promise<object>} JSON-ready status. `service` is null when ECS has no such service.
 */
export async function gatherStatus(target, aws) {
  const { service, primary, tasks } = await loadServiceTasks(target, aws);
  if (!service) {
    return {
      target, service: null, image: null, tasks: [],
      pick: { taskId: null, reason: `ECS has no service ${target.service} in ${target.cluster}` },
    };
  }

  const taskDefinition = primary
    ? await aws.describeTaskDefinition(target.profile, target.region, primary.taskDefinition)
    : null;
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
  lines.push(sessionLine(target, pick));
  return lines.join('\n');
}

function sessionLine(target, pick) {
  if (!pick.taskId) {
    return `No session possible: ${pick.reason}.`;
  }
  return `Sessions will use task ${pick.taskId}: ${pick.reason}.`;
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
  readConfig,
  now = () => new Date(),
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
} = {}) {
  const adapter = aws ?? createAwsAdapter();
  const loaded = await loadTarget(name, options, { aws: adapter, env, readConfig, stderr });
  if (!loaded) {
    return 1;
  }
  const { target, source } = loaded;

  let status;
  try {
    status = await gatherStatus(target, adapter);
  } catch (err) {
    return reportAwsError(stderr, err, { profile: target.profile, source });
  }

  if (options.json) {
    stdout(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    stdout(`${formatStatus(status, { now: now(), paintProd: chalk.red })}\n`);
  }
  return 0;
}
