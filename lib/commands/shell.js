/**
 * shell: open an interactive shell in a running WordPress container.
 */

import chalk from 'chalk';
import { loadTarget, reportError, reportAwsError } from '../cli.js';
import { loadServiceTasks, pickTask } from '../tasks.js';
import {
  execArgs, formatCommandLine, productionNotice, runInteractive,
} from '../session.js';
import { describeError } from '../errors.js';
import { createAwsAdapter } from '../aws.js';

// The image is built on the official wordpress:*-apache base (Debian), which has bash.
// buwp-local's shell opens the same.
export const SHELL_COMMAND = '/bin/bash';

/**
 * @param {string} name - Target name, or its ECS cluster or service name
 * @param {{profile?: string[], task?: string, print?: boolean}} options
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code: the session's, or 1 when it couldn't be opened
 */
export default async function shellCommand(name, options = {}, {
  aws,
  env = process.env,
  readConfig,
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
  isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  run = runInteractive,
} = {}) {
  const adapter = aws ?? createAwsAdapter();
  const loaded = await loadTarget(name, options, { aws: adapter, env, readConfig, stderr });
  if (!loaded) {
    return 1;
  }
  const { target, source } = loaded;

  let picked;
  try {
    const { service, primary, tasks } = await loadServiceTasks(target, adapter);
    if (!service) {
      return reportError(stderr, `ECS has no service ${target.service} in ${target.cluster}.`);
    }
    picked = pickTask(tasks, { primaryTaskDefinitionArn: primary?.taskDefinition, taskId: options.task });
  } catch (err) {
    return reportAwsError(stderr, err, { profile: target.profile, source });
  }
  if (!picked.task) {
    return reportError(stderr, `No session possible on ${target.name}: ${picked.reason}.`);
  }

  const args = execArgs(target, picked.task, SHELL_COMMAND);
  const where = `${target.name}, task ${picked.task.taskId} (${picked.reason})`;
  const flagProduction = () => {
    if (target.production) {
      stderr(`${chalk.red.bold(productionNotice(target))}\n`);
    }
  };

  // --print runs nothing, so it works without a terminal. The command goes to stdout on its own,
  // so it can be copied or captured cleanly; everything else goes to stderr.
  if (options.print) {
    stdout(`${formatCommandLine('aws', args)}\n`);
    flagProduction();
    stderr(chalk.gray(`# ${where}\n`));
    return 0;
  }

  if (!isInteractive()) {
    return reportError(stderr,
      'shell needs an interactive terminal, and would hang without one.',
      'From a script or an agent, add --print to get the AWS command.');
  }

  flagProduction();
  stderr(chalk.gray(`Opening a shell in ${where}. Type exit to leave.\n`));
  try {
    return await run('aws', args);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return reportError(stderr, 'The AWS CLI (aws) isn\'t installed or isn\'t on your PATH.',
        'Install AWS CLI v2 and the Session Manager plugin.');
    }
    return reportError(stderr, describeError(err));
  }
}
