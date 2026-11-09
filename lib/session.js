/**
 * Sessions: building the `aws` command that opens one, printing it, and running it.
 *
 * Sessions go through the AWS CLI and the Session Manager plugin rather than the SDK, because the
 * plugin is what speaks the session protocol. Every command names its profile and region
 * explicitly, so a command printed with --print reaches the same account when a human runs it.
 */

import { spawn as nodeSpawn } from 'child_process';
import { constants } from 'os';
import { WORDPRESS_CONTAINER } from './tasks.js';

/**
 * Append the target's region and, when it has one, profile to an `aws` argument list.
 * @param {object} target
 * @param {string[]} args
 * @returns {string[]}
 */
export function withTargetAccount(target, args) {
  return [...args, '--region', target.region, ...(target.profile ? ['--profile', target.profile] : [])];
}

/**
 * Arguments for `aws` to run a command over ECS Exec in a task's wordpress container.
 * @param {object} target - From findTarget()
 * @param {object} task - From pickTask()
 * @param {string} command - What to run in the container
 * @returns {string[]}
 */
export function execArgs(target, task, command) {
  return withTargetAccount(target, [
    'ecs', 'execute-command',
    '--cluster', target.cluster,
    '--task', task.taskId,
    '--container', WORDPRESS_CONTAINER,
    '--interactive',
    '--command', command,
  ]);
}

/**
 * Quote an argument for a POSIX shell, leaving plain words alone.
 * @param {string} arg
 * @returns {string}
 */
export function shellQuote(arg) {
  const s = String(arg);
  return /^[A-Za-z0-9_/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A command line someone can paste into a shell.
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
export function formatCommandLine(command, args) {
  return [command, ...args].map(shellQuote).join(' ');
}

/**
 * The line shown before working on a production target. Sessions on production are allowed: the
 * label is there so nobody opens one thinking they're in nonprod.
 * @param {object} target
 * @returns {string}
 */
export function productionNotice(target) {
  const why = target.environmentType === 'production'
    ? 'environmentType production'
    : `environmentType ${target.environmentType ?? 'unset'}, treated as production`;
  return `PRODUCTION: ${target.name} (${why}; profile ${target.profile ?? '(default)'})`;
}

/**
 * Start a session command and hand back the child while it runs.
 *
 * While it runs, this process ignores SIGINT. Ctrl-C reaches the child anyway, since the terminal
 * signals the whole process group; ignoring it here means this wrapper outlives the child instead
 * of exiting first and leaving it behind.
 * @param {string} command
 * @param {string[]} args
 * @param {{spawn?: Function, stdio?: string|Array}} opts - stdio defaults to 'inherit'
 * @returns {{child: object, exited: Promise<number>}} exited resolves with the exit code (128 plus
 *   the signal number when a signal ended it), and rejects when the command can't be started.
 */
export function startSession(command, args, { spawn = nodeSpawn, stdio = 'inherit' } = {}) {
  const ignore = () => {};
  process.on('SIGINT', ignore);
  const done = () => process.off('SIGINT', ignore);

  const child = spawn(command, args, { stdio });
  const exited = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code, signal) => {
      done();
      resolve(code ?? 128 + (constants.signals[signal] ?? 0));
    });
  });
  return { child, exited };
}

/**
 * Run a command attached to this terminal and resolve with its exit code.
 * An interactive session puts the terminal in raw mode and passes Ctrl-C to the container.
 * @param {string} command
 * @param {string[]} args
 * @param {{spawn?: Function}} deps - Overridable for tests
 * @returns {Promise<number>} Rejects when the command can't be started (ENOENT and the like)
 */
export function runInteractive(command, args, { spawn = nodeSpawn } = {}) {
  return startSession(command, args, { spawn }).exited;
}
