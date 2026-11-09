/**
 * db tunnel: forward a local port to a target's database, through a running WordPress task.
 * db password: print that database's password.
 *
 * The password is kept out of the tunnel's output on purpose, so it doesn't end up in a terminal
 * scrollback, a log, or an agent's captured output unless someone asks for it.
 */

import chalk from 'chalk';
import { loadTarget, reportError, reportAwsError } from '../cli.js';
import { loadServiceTasks, pickTask } from '../tasks.js';
import { databaseFromTaskDefinition, readSecretRef, parseMysqlGreeting } from '../database.js';
import { portForwardArgs, isPortFree, waitForTunnel } from '../tunnel.js';
import { formatCommandLine, productionNotice, startSession } from '../session.js';
import { describeError } from '../errors.js';
import { createAwsAdapter } from '../aws.js';

// The bu-wp-ecs doc's default: it avoids clashing with a local MySQL on 3306.
export const DEFAULT_LOCAL_PORT = 13306;

const defaultOutput = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

function flagProduction(target, stderr) {
  if (target.production) {
    stderr(`${chalk.red.bold(productionNotice(target))}\n`);
  }
}

/**
 * @param {string} name - Target name, or its ECS cluster or service name
 * @param {{port?: string, task?: string, profile?: string[], print?: boolean}} options
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code
 */
export async function dbTunnelCommand(name, options = {}, {
  aws,
  env = process.env,
  readConfig,
  stdout = defaultOutput.stdout,
  stderr = defaultOutput.stderr,
  start = startSession,
  portFree = isPortFree,
  wait = waitForTunnel,
} = {}) {
  const localPort = options.port === undefined ? DEFAULT_LOCAL_PORT : Number(options.port);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    return reportError(stderr, `--port must be a port number, not "${options.port}".`);
  }

  const adapter = aws ?? createAwsAdapter();
  const loaded = await loadTarget(name, options, { aws: adapter, env, readConfig, stderr });
  if (!loaded) {
    return 1;
  }
  const { target, source } = loaded;

  let picked, database;
  try {
    const { service, primary, tasks } = await loadServiceTasks(target, adapter);
    if (!service) {
      return reportError(stderr, `ECS has no service ${target.service} in ${target.cluster}.`);
    }
    picked = pickTask(tasks, { primaryTaskDefinitionArn: primary?.taskDefinition, taskId: options.task });
    if (picked.task) {
      // The picked task's own definition, so the endpoint is the one that task's WordPress uses.
      database = databaseFromTaskDefinition(
        await adapter.describeTaskDefinition(target.profile, target.region, picked.task.taskDefinitionArn)
      );
    }
  } catch (err) {
    return reportAwsError(stderr, err, { profile: target.profile, source });
  }
  if (!picked.task) {
    return reportError(stderr, `No tunnel possible on ${target.name}: ${picked.reason}.`);
  }

  const args = portForwardArgs(target, picked.task, { host: database.host, port: database.port, localPort });
  const route = `127.0.0.1:${localPort} -> ${database.host}:${database.port}`;
  const where = `${target.name}, task ${picked.task.taskId} (${picked.reason})`;

  if (options.print) {
    stdout(`${formatCommandLine('aws', args)}\n`);
    flagProduction(target, stderr);
    stderr(chalk.gray(`# ${route} through ${where}\n`));
    return 0;
  }

  if (!(await portFree(localPort))) {
    return reportError(stderr, `Local port ${localPort} is already in use, maybe by another tunnel.`,
      `Pick another with --port, for example --port ${localPort + 1}.`);
  }

  flagProduction(target, stderr);
  stderr(chalk.gray(`Opening a tunnel ${route} through ${where}.\n`));

  // The child's stdin is a pipe that's never written or closed: a session that reads EOF on stdin
  // can end itself, and a pipe keeps the tunnel up whether this runs in a terminal or a background
  // job. Ctrl-C still reaches the child through the terminal's process group.
  const session = start('aws', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  let running = true;
  const finished = session.exited.finally(() => {
    running = false;
    session.child.stdin?.destroy();
  });

  let greeting;
  try {
    greeting = await Promise.race([
      wait(localPort, { stillRunning: () => running }),
      finished.then(() => { throw new Error('The tunnel closed before it was ready'); }),
    ]);
  } catch (err) {
    if (running) {
      session.child.kill('SIGTERM');
    }
    await finished.catch(() => {});
    if (err.code === 'ENOENT') {
      return reportError(stderr, 'The AWS CLI (aws) isn\'t installed or isn\'t on your PATH.',
        'Install AWS CLI v2 and the Session Manager plugin.');
    }
    return reportError(stderr, describeError(err));
  }

  const mysql = parseMysqlGreeting(greeting);
  if (mysql) {
    stderr(`${chalk.green('Connected:')} MySQL ${mysql.version} answered through the tunnel.\n`);
  } else {
    stderr(`${chalk.yellow('Warning:')} the tunnel is open, but ${database.host}:${database.port} `
      + 'didn\'t answer like MySQL. You can still try a client.\n');
  }
  stderr([
    `Connect a MySQL client to 127.0.0.1:${localPort} (a standard connection, not SSH):`,
    `  user      ${database.user ?? '(see the task definition)'}`,
    `  database  ${database.name ?? '(see the task definition)'}`,
    `  password  buwp-cloud db password ${target.name}`,
    'Ctrl-C closes the tunnel.',
    '',
  ].join('\n'));

  return finished.catch((err) => reportError(stderr, describeError(err)));
}

/**
 * @param {string} name - Target name, or its ECS cluster or service name
 * @param {{profile?: string[]}} options
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code
 */
export async function dbPasswordCommand(name, options = {}, {
  aws,
  env = process.env,
  readConfig,
  stdout = defaultOutput.stdout,
  stderr = defaultOutput.stderr,
} = {}) {
  const adapter = aws ?? createAwsAdapter();
  const loaded = await loadTarget(name, options, { aws: adapter, env, readConfig, stderr });
  if (!loaded) {
    return 1;
  }
  const { target, source } = loaded;

  try {
    const service = await adapter.describeService(target.profile, target.region, target.cluster, target.service);
    if (!service) {
      return reportError(stderr, `ECS has no service ${target.service} in ${target.cluster}.`);
    }
    const primary = service.deployments?.find((d) => d.status === 'PRIMARY');
    if (!primary) {
      return reportError(stderr, `${target.service} has no current deployment to read the database settings from.`);
    }
    const database = databaseFromTaskDefinition(
      await adapter.describeTaskDefinition(target.profile, target.region, primary.taskDefinition)
    );
    if (!database.passwordRef) {
      return reportError(stderr, 'The wordpress container has no WORDPRESS_DB_PASSWORD secret.');
    }
    const password = await readSecretRef(adapter, target.profile, database.passwordRef);
    flagProduction(target, stderr);
    stdout(`${password}\n`);
    return 0;
  } catch (err) {
    return reportAwsError(stderr, err, { profile: target.profile, source });
  }
}
