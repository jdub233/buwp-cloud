/**
 * Service tasks: summarizing them, and picking the one a session should use.
 *
 * Sessions go into the `wordpress` container of a task that belongs to the WordPress service.
 * Filtering by service matters: the job runner starts short-lived tasks in the same cluster, and
 * an unfiltered task list can hand you one that's about to exit (bu-wp-cluster-ops,
 * connect-to-cluster.md).
 */

export const WORDPRESS_CONTAINER = 'wordpress';
const EXEC_AGENT = 'ExecuteCommandAgent';

/** The task ID at the end of a task ARN. Passes a bare ID through. */
export function taskIdFromArn(arn) {
  return String(arn).split('/').pop();
}

/** "family:revision" from a task definition ARN. */
export function taskDefinitionLabel(arn) {
  return arn ? String(arn).split('/').pop() : null;
}

/**
 * The parts of an ECS task that matter for picking and showing it.
 * @param {object} task - From DescribeTasks
 * @returns {object}
 */
export function summarizeTask(task) {
  const wordpress = task.containers?.find((c) => c.name === WORDPRESS_CONTAINER);
  const agent = wordpress?.managedAgents?.find((a) => a.name === EXEC_AGENT);
  return {
    taskId: taskIdFromArn(task.taskArn),
    taskArn: task.taskArn,
    taskDefinition: taskDefinitionLabel(task.taskDefinitionArn),
    taskDefinitionArn: task.taskDefinitionArn ?? null,
    lastStatus: task.lastStatus ?? null,
    startedAt: task.startedAt ?? null,
    execEnabled: task.enableExecuteCommand === true,
    wordpress: wordpress
      ? {
        runtimeId: wordpress.runtimeId ?? null,
        lastStatus: wordpress.lastStatus ?? null,
        execAgent: agent?.lastStatus ?? null,
      }
      : null,
  };
}

/**
 * Why a session can't go into this task, or null when it can.
 * @param {object} summary - From summarizeTask()
 * @returns {string|null}
 */
export function execBlocker(summary) {
  if (summary.lastStatus !== 'RUNNING') {
    return `task is ${summary.lastStatus ?? 'in an unknown state'}`;
  }
  if (!summary.execEnabled) {
    return 'ECS Exec is not enabled on the task';
  }
  if (!summary.wordpress) {
    return `the task has no ${WORDPRESS_CONTAINER} container`;
  }
  if (summary.wordpress.lastStatus !== 'RUNNING') {
    return `the ${WORDPRESS_CONTAINER} container is ${summary.wordpress.lastStatus ?? 'in an unknown state'}`;
  }
  if (summary.wordpress.execAgent !== 'RUNNING') {
    return `the exec agent is ${summary.wordpress.execAgent ?? 'missing'}`;
  }
  return null;
}

const startTime = (summary) =>
  summary.startedAt ? new Date(summary.startedAt).getTime() : Number.POSITIVE_INFINITY;

/**
 * Choose the task a session should use.
 *
 * Without a pin: the oldest ready task on the service's current (PRIMARY) task definition, so a
 * session doesn't land on a task that a deploy is about to replace. If no task on the current
 * definition is ready, the oldest ready task of any definition.
 * @param {object[]} summaries - The service's tasks, from summarizeTask()
 * @param {{primaryTaskDefinitionArn?: string|null, taskId?: string}} opts - taskId pins one
 * @returns {{task: object|null, reason: string}} When task is null, reason says why
 */
export function pickTask(summaries, { primaryTaskDefinitionArn = null, taskId } = {}) {
  if (taskId) {
    const wanted = taskIdFromArn(taskId);
    const found = summaries.find((s) => s.taskId === wanted);
    if (!found) {
      return { task: null, reason: `task ${wanted} is not a running task of this service` };
    }
    const blocker = execBlocker(found);
    return blocker
      ? { task: null, reason: `task ${wanted} can't take a session: ${blocker}` }
      : { task: found, reason: 'pinned with --task' };
  }

  if (!summaries.length) {
    return { task: null, reason: 'the service has no running tasks' };
  }
  const ready = summaries.filter((s) => !execBlocker(s)).sort((a, b) => startTime(a) - startTime(b));
  if (!ready.length) {
    const why = summaries.map((s) => `${s.taskId}: ${execBlocker(s)}`).join('; ');
    return { task: null, reason: `no task can take a session (${why})` };
  }

  const current = ready.filter((s) => s.taskDefinitionArn === primaryTaskDefinitionArn);
  return current.length
    ? { task: current[0], reason: 'oldest ready task on the current deployment' }
    : { task: ready[0], reason: 'oldest ready task; none on the current deployment is ready' };
}
