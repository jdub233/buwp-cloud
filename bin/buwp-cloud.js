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

// Error handling
program.exitOverride();

// Commander signals a normal help or version exit by throwing. `--help` throws
// commander.helpDisplayed, which buwp-local's list omits, so its `--help` exits 1.
const NORMAL_EXITS = new Set(['commander.help', 'commander.helpDisplayed', 'commander.version']);

try {
  program.parse(process.argv);
} catch (err) {
  if (NORMAL_EXITS.has(err.code)) {
    process.exit(0);
  }
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
}

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
