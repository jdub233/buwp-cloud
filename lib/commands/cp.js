/**
 * cp: copy one file into a running WordPress container, or out of one.
 *
 *   buwp-cloud cp ./fix.php <target>:/var/www/html/wp-content/mu-plugins/site-manager/fix.php
 *   buwp-cloud cp <target>:/tmp/wp-job-12.log .
 *
 * A copy into a container is a hot patch: it lasts until the task is replaced, and tasks started
 * later come from the image without it. On a service with more than one task the ALB spreads
 * requests across them (bu-wp-ecs sets no stickiness), so patching one of several is only right
 * when the point is to run something on that task. cp makes that a choice: --task for one task,
 * --all-tasks for every one.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { loadTarget, loadSessionTask, reportError, reportAwsError } from '../cli.js';
import { loadServiceTasks, pickTask, execBlocker } from '../tasks.js';
import { productionNotice, startSession, shellQuote } from '../session.js';
import {
  newNonce, wrapCapture, printableScriptFor, printedCommand, runCaptured, sessionFailure,
} from '../capture.js';
import {
  parseLocation, newCopyId, sha256, chunks, appendCommand, dropFunction, readFunction,
  parseDropReport, parseReadOutput, stagingPath, CHUNK_CHARS,
} from '../filecopy.js';
import { reportSessionError, reportSessionFailure } from './exec.js';
import { describeError } from '../errors.js';
import { createAwsAdapter } from '../aws.js';

const COPY_LABEL = 'buwp:cp';

/** Local file access, overridable for tests. */
const localFiles = {
  read: (p) => fs.readFileSync(p),
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  // Written beside the destination and renamed, so a failed copy never leaves half a file.
  write: (p, data) => {
    const tmp = `${p}.buwp-${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, p);
  },
};

/**
 * @param {string} source - A local path, or <target>:<path>
 * @param {string} destination - A local path ("-" for stdout), or <target>:<path>
 * @param {{task?: string, allTasks?: boolean, print?: boolean, profile?: string[]}} options
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code
 */
export default async function cpCommand(source, destination, options = {}, deps = {}) {
  const d = {
    env: process.env,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    start: startSession,
    nonce: newNonce,
    copyId: newCopyId,
    files: localFiles,
    ...deps,
  };
  d.aws = deps.aws ?? createAwsAdapter();

  const from = parseLocation(source);
  const to = parseLocation(destination);
  if (Boolean(from.target) === Boolean(to.target)) {
    return reportError(d.stderr, 'One side has to be <target>:<path> in the container, and the other a local path.',
      'For a local path with a colon in it, start it with ./');
  }
  const remote = from.target ? from : to;
  if (!remote.path.startsWith('/')) {
    return reportError(d.stderr, `Container paths have to be absolute, not "${remote.path}".`,
      `For example: ${remote.target}:/var/www/html/wp-content/...`);
  }
  if (options.task && options.allTasks) {
    return reportError(d.stderr, 'Use --task or --all-tasks, not both.');
  }
  return to.target ? copyIn(from.local, to, options, d) : copyOut(from, to.local, options, d);
}

/** The tasks a copy into the service goes to, or null after reporting why there are none. */
function chooseTasks(target, service, tasks, primary, options, stderr) {
  if (options.allTasks) {
    if (!tasks.length) {
      reportError(stderr, `${target.service} has no running tasks.`);
      return null;
    }
    const blocked = tasks.filter((t) => execBlocker(t));
    if (blocked.length) {
      reportError(stderr, `Not every task can take a session (${blocked.map((t) => `${t.taskId}: ${execBlocker(t)}`).join('; ')}).`,
        'Copying to the rest would leave the service serving two versions. Try again once status shows them all ready.');
      return null;
    }
    return tasks;
  }
  if (!options.task && (tasks.length > 1 || service.desiredCount > 1)) {
    const count = Math.max(tasks.length, service.desiredCount ?? 0);
    reportError(stderr, `${target.service} runs ${count} tasks, and the ALB spreads requests across them.`,
      'Choose: --task <id> to patch one task (for example, to run a job on it), or --all-tasks so every '
      + 'request sees the change. status lists the tasks.');
    return null;
  }
  const picked = pickTask(tasks, { primaryTaskDefinitionArn: primary?.taskDefinition, taskId: options.task });
  if (!picked.task) {
    reportError(stderr, `No session possible on ${target.name}: ${picked.reason}.`);
    return null;
  }
  return [picked.task];
}

/** Warnings about how long a hot patch lasts, for the target and the tasks it went to. */
function lifetimeNotes(target, service, count) {
  const which = count === 1 ? 'the task is' : 'the tasks are';
  const notes = [
    `This lasts until ${which} replaced. A deploy, a restart or a scale-in starts tasks from the image, `
    + 'without this file. To keep it, ship it in the image.',
  ];
  if (target.autoscaling) {
    notes.push(`${service.serviceName} autoscales, so tasks can come and go within minutes, and new ones won't have this file.`);
  }
  if (target.jobRunner?.enabled) {
    notes.push(`Scheduled jobs (${target.jobRunner.schedule ?? 'job runner'}) run in new tasks, which won't have this file.`);
  }
  return notes;
}

async function copyIn(localPath, remote, options, d) {
  const { stdout, stderr } = d;
  let data;
  try {
    data = d.files.read(localPath);
  } catch (err) {
    if (err.code === 'EISDIR') {
      return reportError(stderr, `cp copies one file, and ${localPath} is a directory.`);
    }
    if (err.code === 'ENOENT') {
      return reportError(stderr, `There's no local file ${localPath}.`);
    }
    return reportError(stderr, describeError(err));
  }
  const name = path.basename(localPath);
  const dest = remote.path.endsWith('/') ? `${remote.path}${name}` : remote.path;
  const expected = sha256(data);
  const b64 = data.toString('base64');

  const loaded = await loadTarget(remote.target, options, { aws: d.aws, env: d.env, readConfig: d.readConfig, stderr });
  if (!loaded) {
    return 1;
  }
  const { target, source } = loaded;
  let service, primary, tasks;
  try {
    ({ service, primary, tasks } = await loadServiceTasks(target, d.aws));
  } catch (err) {
    return reportAwsError(stderr, err, { profile: target.profile, source });
  }
  if (!service) {
    return reportError(stderr, `ECS has no service ${target.service} in ${target.cluster}.`);
  }
  const chosen = chooseTasks(target, service, tasks, primary, options, stderr);
  if (!chosen) {
    return 1;
  }

  const flagProduction = () => {
    if (target.production) {
      stderr(`${chalk.red.bold(productionNotice(target))}\n`);
    }
  };
  const taskList = chosen.map((t) => t.taskId).join(', ');
  const notes = lifetimeNotes(target, service, chosen.length);

  if (options.print) {
    if (b64.length > CHUNK_CHARS) {
      return reportError(stderr, `${localPath} is too big for one printed command (${data.length} bytes).`,
        'Run buwp-cloud cp itself, which sends a file this size in pieces.');
    }
    const id = d.copyId();
    const script = printableScriptFor('buwp_cp "$1"', { preamble: dropFunction({ id, dest, name, sha256: expected }) });
    stdout(printedCommand(target, chosen, script, COPY_LABEL, {
      setup: [`b64=$(base64 < ${shellQuote(path.resolve(localPath))} | tr -d '\\n')`],
      argsExpression: '$b64',
    }));
    flagProduction();
    stderr(chalk.gray(`# ${target.name}:${dest} on task ${taskList}\n`));
    stderr(chalk.gray(`# The copy is refused unless the file's sha256 is still ${expected}.\n`));
    notes.forEach((n) => stderr(chalk.gray(`# ${n}\n`)));
    return 0;
  }

  const pieces = chunks(b64);
  flagProduction();
  stderr(chalk.gray(`Copying ${localPath} (${data.length} bytes${pieces.length > 1 ? `, in ${pieces.length} pieces` : ''}) `
    + `to ${target.name}:${dest} on task ${taskList}.\n`));

  const done = [];
  for (const task of chosen) {
    const id = d.copyId();
    const run = async (command, args, preamble = []) => {
      const nonce = d.nonce();
      let collected = '';
      const result = await runCaptured(target, task, {
        script: wrapCapture(command, { nonce, preamble }), nonce, label: COPY_LABEL, args,
      }, { start: d.start, stdout: (s) => { collected += s; }, stderr });
      return { ...result, output: collected };
    };

    let result;
    try {
      for (const piece of pieces.slice(0, -1)) {
        result = await run(appendCommand(id), [piece]);
        if (result.status !== 0) {
          break;
        }
      }
      if (!result || result.status === 0) {
        result = await run('buwp_cp "$1"', [pieces[pieces.length - 1]],
          dropFunction({ id, dest, name, sha256: expected }));
      } else {
        // A piece failed: clear what's collected so far. Best effort; it's a hidden file in /tmp.
        await run(`rm -f ${shellQuote(stagingPath(id))}`, []).catch(() => {});
      }
    } catch (err) {
      return reportSessionError(stderr, err);
    }

    const failure = sessionFailure(result);
    if (failure) {
      reportSessionFailure(stderr, failure);
      return finishEarly(stderr, done, chosen.length);
    }
    const report = result.status === 0 ? parseDropReport(result.output) : null;
    if (!report) {
      // buwp_cp has already said why on stderr.
      reportError(stderr, `The copy to task ${task.taskId} failed.`);
      return finishEarly(stderr, done, chosen.length);
    }
    done.push(task.taskId);
    const replaced = report.old ? `replaced ${report.old.slice(0, 12)}` : 'new file';
    stderr(`${chalk.green('Copied:')} task ${task.taskId}: ${report.path}, ${report.bytes} bytes, `
      + `${report.owner} ${report.mode}, sha256 ${report.sha256.slice(0, 12)} (${replaced}).\n`);
  }

  if (options.allTasks) {
    try {
      const now = await loadServiceTasks(target, d.aws);
      const missed = now.tasks.filter((t) => !done.includes(t.taskId));
      if (missed.length) {
        stderr(`${chalk.yellow('Warning:')} ${missed.map((t) => t.taskId).join(', ')} started while copying and `
          + `${missed.length === 1 ? "doesn't" : "don't"} have the file. Run the copy again with --all-tasks.\n`);
      }
    } catch (err) {
      stderr(`${chalk.yellow('Warning:')} couldn't check for tasks that started while copying: ${describeError(err)}\n`);
    }
  }
  notes.forEach((n) => stderr(`${chalk.yellow('Note:')} ${n}\n`));
  return 0;
}

/** After a failed copy to one of several tasks, say which already have the file. */
function finishEarly(stderr, done, total) {
  if (total > 1) {
    stderr(done.length
      ? `${chalk.yellow('Warning:')} stopped. ${done.join(', ')} already ${done.length === 1 ? 'has' : 'have'} the new file; the other tasks don't.\n`
      : 'Stopped before any task was changed.\n');
  }
  return 1;
}

async function copyOut(remote, localPath, options, d) {
  const { stdout, stderr } = d;
  if (options.allTasks) {
    return reportError(stderr, '--all-tasks is for copying into a container.');
  }
  if (options.print) {
    return reportError(stderr, '--print is for copying into a container. Copying out changes nothing there.');
  }
  const loaded = await loadSessionTask(remote.target, options, { aws: d.aws, env: d.env, readConfig: d.readConfig, stderr });
  if (!loaded) {
    return 1;
  }
  const { target, task } = loaded;

  const nonce = d.nonce();
  let collected = '';
  let result;
  try {
    result = await runCaptured(target, task, {
      script: wrapCapture('buwp_get', { nonce, preamble: readFunction(remote.path) }), nonce, label: COPY_LABEL,
    }, { start: d.start, stdout: (s) => { collected += s; }, stderr });
  } catch (err) {
    return reportSessionError(stderr, err);
  }
  const failure = sessionFailure(result);
  if (failure) {
    return reportSessionFailure(stderr, failure);
  }
  if (result.status !== 0) {
    return result.status;
  }

  let file;
  try {
    file = parseReadOutput(collected);
  } catch (err) {
    return reportError(stderr, err.message);
  }
  const where = `${target.name}:${remote.path} from task ${task.taskId}`;
  if (localPath === '-') {
    stdout(file.data);
    stderr(chalk.gray(`Copied ${where} (${file.data.length} bytes, sha256 ${file.sha256.slice(0, 12)}).\n`));
    return 0;
  }
  const out = d.files.isDirectory(localPath) ? path.join(localPath, path.basename(remote.path)) : localPath;
  try {
    d.files.write(out, file.data);
  } catch (err) {
    return reportError(stderr, `Couldn't write ${out}: ${describeError(err)}`);
  }
  stderr(`${chalk.green('Copied:')} ${where} to ${out}, ${file.data.length} bytes, sha256 ${file.sha256.slice(0, 12)}.\n`);
  return 0;
}
