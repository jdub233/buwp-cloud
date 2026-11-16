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
import {
  execArgs, productionNotice, singleTaskWarning, startSession,
} from '../session.js';
import {
  newNonce, sessionLabel, captureScript, printableScript, remoteCommand, printedCommand,
  createOutputSplitter,
} from '../capture.js';
import { describeError } from '../errors.js';
import { createAwsAdapter } from '../aws.js';

// Like ssh: the exit code when the session ended without reporting the command's exit status.
export const NO_STATUS_EXIT_CODE = 255;

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
  const script = captureScript(words, { nonce: id, piped: !stdoutIsTerminal() });
  const args = execArgs(target, task, remoteCommand(script, label));
  const splitter = createOutputSplitter(id, { stdout, stderr });

  // As with db tunnel, the child's stdin is a pipe that stays open and unwritten: with stdin at
  // end-of-file, the plugin can end the session early. The AWS CLI's own errors go straight to
  // stderr.
  const session = start('aws', args, { stdio: ['pipe', 'pipe', 'inherit'] });
  session.child.stdout?.setEncoding('utf8');
  session.child.stdout?.on('data', (chunk) => splitter.push(chunk));

  let awsExit;
  try {
    awsExit = await session.exited;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return reportError(stderr, 'The AWS CLI (aws) isn\'t installed or isn\'t on your PATH.',
        'Install AWS CLI v2 and the Session Manager plugin.');
    }
    return reportError(stderr, describeError(err));
  } finally {
    session.child.stdin?.destroy();
  }

  const { started, status, other } = splitter.end();
  if (status !== null) {
    return status;
  }
  if (!started) {
    // Whatever the plugin printed instead of the command's output says why.
    for (const text of other.filter((t) => t.trim())) {
      stderr(`${text}\n`);
    }
    reportError(stderr, `The session ended before the command started (aws exited ${awsExit}).`);
    return awsExit || 1;
  }
  reportError(stderr, 'The session ended before the command finished, so its exit status is unknown.',
    'It may have finished, or may still be running, in the container. Check before running it again.');
  return NO_STATUS_EXIT_CODE;
}
