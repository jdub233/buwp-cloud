#!/usr/bin/env node

/**
 * buwp-cloud CLI
 * Operates Boston University's WordPress clusters on AWS ECS. The companion to buwp-local.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Import commands
import clustersCommand from '../lib/commands/clusters.js';
import configCommand from '../lib/commands/config.js';
import initCommand from '../lib/commands/init.js';
import statusCommand from '../lib/commands/status.js';
import shellCommand from '../lib/commands/shell.js';
import execCommand from '../lib/commands/exec.js';
import logsCommand, { DEFAULT_SINCE } from '../lib/commands/logs.js';
import cpCommand from '../lib/commands/cp.js';
import { dbTunnelCommand, dbPasswordCommand, DEFAULT_LOCAL_PORT } from '../lib/commands/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8')
);

const program = new Command();

program
  .name('buwp-cloud')
  .description("Operate Boston University's WordPress clusters on AWS ECS")
  .version(packageJson.version);

// Commands are registered here as they land, one module per command in lib/commands/<name>.js.

/**
 * Commander option parser that collects a repeatable flag into an array. It has no default value,
 * so help doesn't show "(default: [])"; an unused flag is undefined.
 */
const collect = (value, previous = []) => [...previous, value];

// Clusters command
program
  .command('clusters')
  .description('List the WordPress clusters your AWS profiles can reach')
  .option('--profile <name>',
    'AWS profile to search; repeat for more (default: AWS_PROFILE, then the config file, then the default credential chain)',
    collect)
  .option('--json', 'Output JSON')
  .action(async (options) => {
    process.exitCode = await clustersCommand(options);
  });

// Status command
program
  .command('status <target>')
  .description("Show a target's WordPress service, its tasks, and which task sessions will use")
  .option('--profile <name>', 'AWS profile to search; repeat for more (default: as for clusters)', collect)
  .option('--json', 'Output JSON')
  .action(async (target, options) => {
    process.exitCode = await statusCommand(target, options);
  });

// Shell command
program
  .command('shell <target>')
  .description('Open an interactive shell in a running WordPress container')
  .option('--task <id>', 'Use this task instead of the one buwp-cloud picks (see status)')
  .option('--profile <name>', 'AWS profile to search; repeat for more (default: as for clusters)', collect)
  .option('--print', 'Print the AWS CLI command instead of running it')
  .action(async (target, options) => {
    process.exitCode = await shellCommand(target, options);
  });

// Exec command: the default, so `buwp-cloud <target> -- <command>` reaches it.
program
  .command('exec <target> [command...]', { isDefault: true })
  .usage('[options] <target> -- <command...>')
  .description('Run one command in a running WordPress container (the default: buwp-cloud <target> -- <command>)')
  .option('--task <id>', 'Use this task instead of the one buwp-cloud picks (see status)')
  .option('--profile <name>', 'AWS profile to search; repeat for more (default: as for clusters)', collect)
  .option('--print', 'Print the AWS CLI command instead of running it')
  .addHelpText('after', `
Everything after -- runs in the container, each word as one argument. For shell syntax (pipes,
globs, ;), run sh -c '...'. Local stdin isn't sent.

Examples:
  buwp-cloud <target> -- wp option get home
  buwp-cloud <target> -- wp site list --format=json | jq .
  buwp-cloud <target> -- sh -c 'ls -la /tmp | tail'`)
  .action(async (target, command, options) => {
    // Without --, the first word was most likely a mistyped command name, not a target.
    if (!process.argv.slice(2).includes('--')) {
      program.error(`error: unknown command '${target}'\n`
        + 'To run something in a container, put it after --: buwp-cloud <target> -- <command>');
    }
    process.exitCode = await execCommand(target, command, options);
  });

// Cp command
program
  .command('cp <source> <destination>')
  .description('Copy one file into a running WordPress container, or out of one')
  .option('--task <id>', 'Copy to or from this task (see status)')
  .option('--all-tasks', 'Copy into every task of the service, so every request sees the change')
  .option('--profile <name>', 'AWS profile to search; repeat for more (default: as for clusters)', collect)
  .option('--print', 'Print the AWS CLI commands instead of copying (copies into a container only)')
  .addHelpText('after', `
One side is <target>:<absolute path in the container>; the other is a local path, or - for stdout
when copying out.

Copying in writes the file beside the destination under a temporary name, keeps the old file's
owner and mode (a new file gets its directory's owner and mode 644), checks its sha256, runs
php -l on .php files, and only then moves it into place. A file that fails a check leaves the old
one untouched.

A copy in is a hot patch: it lasts until the task is replaced. On a service with more than one
task, choose --task for one task or --all-tasks for every one.

Examples:
  buwp-cloud cp ./fix.php <target>:/var/www/html/wp-content/mu-plugins/site-manager/fix.php
  buwp-cloud cp <target>:/tmp/wp-job-12.log .`)
  .action(async (source, destination, options) => {
    process.exitCode = await cpCommand(source, destination, options);
  });

// Logs command
program
  .command('logs <target>')
  .description("Read a target's WordPress logs: requests, PHP errors, cron and job-runner output")
  .option('--since <when>', `Start: a duration back from now (30s, 15m, 2h, 3d) or a local date and time (default: ${DEFAULT_SINCE})`)
  .option('--until <when>', 'End, in the same forms (default: now)')
  .option('--grep <text>', 'Only events containing this text (case-sensitive)')
  .option('--filter-pattern <pattern>', 'Only events matching a CloudWatch filter pattern')
  .option('--task <id>', "Only this task's events; any task, including a stopped job-runner task")
  .option('--sessions', 'Search ECS Exec session transcripts instead: what each shell or exec session printed')
  .option('--health-checks', 'Include passing ALB health checks, which are hidden by default')
  .option('-f, --follow', 'Keep printing new events until interrupted')
  .option('--profile <name>', 'AWS profile to search; repeat for more (default: as for clusters)', collect)
  .option('--json', 'Output JSON')
  .action(async (target, options) => {
    process.exitCode = await logsCommand(target, options);
  });

// Database commands
const db = program
  .command('db')
  .description("Reach the database a target's WordPress uses");

db
  .command('tunnel <target>')
  .description('Forward a local port to the database, through a running WordPress task')
  .option('--port <number>', `Local port to listen on (default: ${DEFAULT_LOCAL_PORT})`)
  .option('--task <id>', 'Use this task instead of the one buwp-cloud picks (see status)')
  .option('--profile <name>', 'AWS profile to search; repeat for more (default: as for clusters)', collect)
  .option('--print', 'Print the AWS CLI command instead of running it')
  .action(async (target, options) => {
    process.exitCode = await dbTunnelCommand(target, options);
  });

db
  .command('password <target>')
  .description('Print the database password, for example to pipe into pbcopy')
  .option('--profile <name>', 'AWS profile to search; repeat for more (default: as for clusters)', collect)
  .action(async (target, options) => {
    process.exitCode = await dbPasswordCommand(target, options);
  });

// Config command
program
  .command('config')
  .description('Show, create or check the .buwp-cloud.json config file')
  .option('--show', 'Show the config file in effect and the profiles it resolves to (the default)')
  .option('--init', 'Create .buwp-cloud.json in the current directory')
  .option('--validate', 'Check the config file in effect')
  .option('--profile <name>', 'With --init: an AWS profile to list; repeat for more', collect)
  .option('-f, --force', 'With --init: replace an existing file')
  .option('--json', 'With --show: output JSON')
  .action(async (options) => {
    process.exitCode = await configCommand(options);
  });

program
  .command('init')
  .description('Set up buwp-cloud: pick from your AWS profiles the ones to search, and where to save them')
  .option('--no-interactive', 'Skip the menus and save the --profile flags (or AWS_PROFILE), as config --init does')
  .option('--profile <name>', 'An AWS profile to save, skipping the menus; repeat for more', collect)
  .option('--home', 'Without the menus: save to ~/.buwp-cloud.json instead of the current directory')
  .option('-f, --force', 'Without the menus: replace an existing file')
  .addHelpText('after', `
In a terminal, init lists the profiles in ~/.aws/config and ~/.aws/credentials (names only, never
keys or tokens), checks what each reaches, and asks which to save and where.`)
  .action(async (options) => {
    process.exitCode = await initCommand(options);
  });

// Show help if no command provided. This has to run before parsing: once subcommands exist,
// commander answers a bare invocation itself, with help on stderr.
if (!process.argv.slice(2).length) {
  program.outputHelp();
  process.exit(0);
}

// Error handling
program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Commander has already printed its own message for help, version and usage errors, and its
  // exitCode says which it was: 0 for `--help` and `--version`, 1 for a usage error. (buwp-local
  // exits 0 only for a fixed list of codes, which misses `--help`, so its `--help` exits 1.)
  if (err.code?.startsWith('commander.')) {
    process.exit(err.exitCode);
  }
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
}
