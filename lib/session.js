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
 * Run a command attached to this terminal and resolve with its exit code.
 *
 * While it runs, this process ignores SIGINT. An interactive session puts the terminal in raw
 * mode and passes Ctrl-C through to the container, but a Ctrl-C that arrives before or after
 * that should end the child, not leave it behind when this wrapper exits first.
 * @param {string} command
 * @param {string[]} args
 * @param {{spawn?: Function}} deps - Overridable for tests
 * @returns {Promise<number>} Rejects when the command can't be started (ENOENT and the like)
 */
export function runInteractive(command, args, { spawn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const ignore = () => {};
    process.on('SIGINT', ignore);
    const done = () => process.off('SIGINT', ignore);

    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code, signal) => {
      done();
      resolve(code ?? 128 + (constants.signals[signal] ?? 0));
    });
  });
}
