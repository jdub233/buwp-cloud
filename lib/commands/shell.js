/**
 * shell: open an interactive shell in a running WordPress container.
 */

import chalk from 'chalk';
import { loadSessionTask, reportError } from '../cli.js';
import {
  execArgs, formatCommandLine, productionNotice, singleTaskWarning, runInteractive,
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
  const loaded = await loadSessionTask(name, options, { aws: adapter, env, readConfig, stderr });
  if (!loaded) {
    return 1;
  }
  const { target, service, task, reason } = loaded;

  const args = execArgs(target, task, SHELL_COMMAND);
  const where = `${target.name}, task ${task.taskId} (${reason})`;
  const warning = singleTaskWarning(service);
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
    if (warning) {
      stderr(chalk.gray(`# ${warning}\n`));
    }
    return 0;
  }

  if (!isInteractive()) {
    return reportError(stderr,
      'shell needs an interactive terminal, and would hang without one.',
      'From a script or an agent, run one command with buwp-cloud <target> -- <command>, or add --print to get the AWS command.');
  }

  flagProduction();
  if (warning) {
    stderr(`${chalk.yellow('Note:')} ${warning}\n`);
  }
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
