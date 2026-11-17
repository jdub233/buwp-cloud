/**
 * exec: run one command in a running WordPress container, and pass back its output and exit status.
 *
 *   buwp-cloud <target> -- wp option get home
 *
 * It's the default command, so `exec` itself can be left out. The command's stdout and stderr come
 * back separately and its exit status becomes this process's, so it works in a pipeline, a script
 * or an agent's shell. When stdout here isn't a terminal, wp-cli is told it's piped (no color,
 * tab-separated tables), as it would be locally.
 */

import chalk from 'chalk';
import { loadSessionTask, reportError } from '../cli.js';
import { productionNotice, singleTaskWarning, startSession } from '../session.js';
import {
  newNonce, sessionLabel, captureScript, printableScript, printedCommand, runCaptured,
  sessionFailure, NO_STATUS_EXIT_CODE,
} from '../capture.js';
import { describeError } from '../errors.js';
import { createAwsAdapter } from '../aws.js';

export { NO_STATUS_EXIT_CODE };

/**
 * @param {string} name - Target name, or its ECS cluster or service name
 * @param {string[]} words - The command to run, one argument per word
 * @param {{profile?: string[], task?: string, print?: boolean}} options
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} The command's exit status; 1 when no session could start; 255 when the
 *   session ended without reporting one
 */
export default async function execCommand(name, words, options = {}, {
  aws,
  env = process.env,
  readConfig,
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
  stdoutIsTerminal = () => Boolean(process.stdout.isTTY),
  start = startSession,
  nonce = newNonce,
} = {}) {
  if (!words.length) {
    return reportError(stderr, 'Nothing to run.',
      'Put the command after --, for example: buwp-cloud <target> -- wp option get home');
  }

  const adapter = aws ?? createAwsAdapter();
  const loaded = await loadSessionTask(name, options, { aws: adapter, env, readConfig, stderr });
  if (!loaded) {
    return 1;
  }
  const { target, service, task, reason } = loaded;

  const label = sessionLabel(words);
  const where = `${target.name}, task ${task.taskId} (${reason})`;
  const warning = singleTaskWarning(service);
  const flagProduction = () => {
    if (target.production) {
      stderr(`${chalk.red.bold(productionNotice(target))}\n`);
    }
  };

  // The printed command is for someone to run in a terminal, so it's composed for one.
  if (options.print) {
    stdout(printedCommand(target, task, printableScript(words), label));
    flagProduction();
    stderr(chalk.gray(`# ${where}\n`));
    if (warning) {
      stderr(chalk.gray(`# ${warning}\n`));
    }
    return 0;
  }

  flagProduction();
  if (warning) {
    stderr(`${chalk.yellow('Note:')} ${warning}\n`);
  }
  stderr(chalk.gray(`Running in ${where}.\n`));

  const id = nonce();
  let result;
  try {
    result = await runCaptured(target, task, {
      script: captureScript(words, { nonce: id, piped: !stdoutIsTerminal() }),
      nonce: id,
      label,
    }, { start, stdout, stderr });
  } catch (err) {
    return reportSessionError(stderr, err);
  }
  const failure = sessionFailure(result);
  return failure ? reportSessionFailure(stderr, failure) : result.status;
}

/**
 * Report an `aws` that couldn't be started.
 * @returns {1}
 */
export function reportSessionError(stderr, err) {
  if (err.code === 'ENOENT') {
    return reportError(stderr, 'The AWS CLI (aws) isn\'t installed or isn\'t on your PATH.',
      'Install AWS CLI v2 and the Session Manager plugin.');
  }
  return reportError(stderr, describeError(err));
}

/**
 * Report a captured run that ended without an exit status, from sessionFailure().
 * @returns {number} The exit code to use
 */
export function reportSessionFailure(stderr, failure) {
  // Whatever the plugin printed instead of the command's output says why.
  for (const text of failure.details) {
    stderr(`${text}\n`);
  }
  reportError(stderr, failure.message, failure.hint);
  return failure.code;
}
