/**
 * Shared steps for commands that act on one target: resolve the profiles, find the target, and
 * report failures the same way everywhere.
 */

import chalk from 'chalk';
import { loadConfig, resolveProfiles } from './config.js';
import { findTarget, TargetError } from './targets.js';
import { loadServiceTasks, pickTask } from './tasks.js';
import { credentialHint, describeError, errorCode } from './errors.js';

/**
 * Write an error, with an optional indented hint on the next line.
 * @param {(s: string) => void} stderr
 * @param {string} message
 * @param {string|null} [hint]
 * @returns {1} The exit code, so callers can `return reportError(...)`
 */
export function reportError(stderr, message, hint = null) {
  stderr(`${chalk.red('Error:')} ${message}\n`);
  if (hint) {
    stderr(`  ${hint}\n`);
  }
  return 1;
}

/**
 * Report an AWS call that failed while working on a target, with a credential hint if it is one.
 * @returns {1}
 */
export function reportAwsError(stderr, err, { profile, source }) {
  return reportError(stderr, describeError(err), credentialHint({ code: errorCode(err), profile }, { source }));
}

/**
 * Resolve profiles and find the named target, reporting any failure.
 * @param {string} name - Target name, or its ECS cluster or service name
 * @param {{profile?: string[]}} options - Command options; `profile` holds --profile flags
 * @param {{aws: object, env: NodeJS.ProcessEnv, readConfig?: Function, stderr: Function}} deps
 * @returns {Promise<{target: object, source: string}|null>} null when it failed and was reported
 */
export async function loadTarget(name, options, { aws, env, readConfig = () => loadConfig({ env }), stderr }) {
  let profiles, source;
  try {
    ({ profiles, source } = resolveProfiles({ cliProfiles: options.profile ?? [], env, readConfig }));
  } catch (err) {
    reportError(stderr, describeError(err));
    return null;
  }

  try {
    const { target } = await findTarget(name, { profiles, source, aws });
    return { target, source };
  } catch (err) {
    if (!(err instanceof TargetError)) {
      reportError(stderr, describeError(err));
      return null;
    }
    reportError(stderr, err.message);
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
    return null;
  }
}

/**
 * Find the named target and pick the task a session will use, reporting any failure.
 * @param {string} name - Target name, or its ECS cluster or service name
 * @param {{profile?: string[], task?: string}} options - `task` pins a task
 * @param {{aws: object, env: NodeJS.ProcessEnv, readConfig?: Function, stderr: Function}} deps
 * @returns {Promise<{target: object, source: string, service: object, task: object, reason: string}|null>}
 *   null when it failed and was reported
 */
export async function loadSessionTask(name, options, { aws, env, readConfig, stderr }) {
  const loaded = await loadTarget(name, options, { aws, env, readConfig, stderr });
  if (!loaded) {
    return null;
  }
  const { target, source } = loaded;

  let service, picked;
  try {
    let primary, tasks;
    ({ service, primary, tasks } = await loadServiceTasks(target, aws));
    if (!service) {
      reportError(stderr, `ECS has no service ${target.service} in ${target.cluster}.`);
      return null;
    }
    picked = pickTask(tasks, { primaryTaskDefinitionArn: primary?.taskDefinition, taskId: options.task });
  } catch (err) {
    reportAwsError(stderr, err, { profile: target.profile, source });
    return null;
  }
  if (!picked.task) {
    reportError(stderr, `No session possible on ${target.name}: ${picked.reason}.`);
    return null;
  }
  return { target, source, service, task: picked.task, reason: picked.reason };
}
