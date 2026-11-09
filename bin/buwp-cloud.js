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
import statusCommand from '../lib/commands/status.js';
import shellCommand from '../lib/commands/shell.js';

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

/** Commander option parser that collects a repeatable flag into an array. */
const collect = (value, previous) => [...previous, value];

// Clusters command
program
  .command('clusters')
  .description('List the WordPress clusters your AWS profiles can reach')
  .option('--profile <name>',
    'AWS profile to search; repeat for more (default: AWS_PROFILE, then the config file, then the default credential chain)',
    collect, [])
  .option('--json', 'Output JSON')
  .action(async (options) => {
    process.exitCode = await clustersCommand(options);
  });

// Status command
program
  .command('status <target>')
  .description("Show a target's WordPress service, its tasks, and which task sessions will use")
  .option('--profile <name>', 'AWS profile to search; repeat for more (default: as for clusters)', collect, [])
  .option('--json', 'Output JSON')
  .action(async (target, options) => {
    process.exitCode = await statusCommand(target, options);
  });

// Shell command
program
  .command('shell <target>')
  .description('Open an interactive shell in a running WordPress container')
  .option('--task <id>', 'Use this task instead of the one buwp-cloud picks (see status)')
  .option('--profile <name>', 'AWS profile to search; repeat for more (default: as for clusters)', collect, [])
  .option('--print', 'Print the AWS CLI command instead of running it')
  .action(async (target, options) => {
    process.exitCode = await shellCommand(target, options);
  });

// Config command
program
  .command('config')
  .description('Show, create or check the .buwp-cloud.json config file')
  .option('--show', 'Show the config file in effect and the profiles it resolves to (the default)')
  .option('--init', 'Create .buwp-cloud.json in the current directory')
  .option('--validate', 'Check the config file in effect')
  .option('--profile <name>', 'With --init: an AWS profile to list; repeat for more', collect, [])
  .option('-f, --force', 'With --init: replace an existing file')
  .option('--json', 'With --show: output JSON')
  .action(async (options) => {
    process.exitCode = await configCommand(options);
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
