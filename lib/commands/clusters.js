/**
 * clusters: list the WordPress clusters your AWS profiles can reach.
 */

import chalk from 'chalk';
import { loadConfig, resolveProfiles } from '../config.js';
import { discoverTargets } from '../discovery.js';
import { credentialHint, describeError } from '../errors.js';
import { createAwsAdapter } from '../aws.js';
import { formatTable, formatJobRunner } from '../format.js';

const COLUMNS = ['TARGET', 'PROD', 'ENVIRONMENT', 'REGION', 'PROFILE', 'JOB RUNNER'];
const PROD_COLUMN = 1;

/**
 * Render targets as an aligned text table.
 * @param {object[]} targets
 * @param {{paintProd?: (s: string) => string}} options - Styles the PROD cell of production
 *   targets, after padding so escape codes don't throw off alignment.
 * @returns {string}
 */
export function formatTargetsTable(targets, { paintProd = (s) => s } = {}) {
  const rows = targets.map((t) => [
    t.name,
    t.production ? 'yes' : 'no',
    t.environmentType ?? 'unset',
    t.region ?? '-',
    t.profile ?? '(default)',
    formatJobRunner(t.jobRunner),
  ]);

  return formatTable(COLUMNS, rows, {
    paint: (cell, r, c) => (c === PROD_COLUMN && targets[r].production ? paintProd(cell) : cell),
  });
}

/**
 * @param {{profile?: string[], json?: boolean}} options
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code. 1 when every profile failed or the config is invalid.
 */
export default async function clustersCommand(options = {}, {
  aws,
  env = process.env,
  readConfig = () => loadConfig({ env }),
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
} = {}) {
  let profiles, source, configFiles;
  try {
    ({ profiles, source, configFiles } =
      resolveProfiles({ cliProfiles: options.profile ?? [], env, readConfig }));
  } catch (err) {
    stderr(`${chalk.red('Error:')} ${describeError(err)}\n`);
    return 1;
  }

  const discovered = await discoverTargets({ profiles, aws: aws ?? createAwsAdapter() });
  const { targets } = discovered;
  const errors = discovered.errors.map((error) => {
    const hint = credentialHint(error, { source });
    return hint ? { ...error, hint } : error;
  });
  const failedProfiles = new Set(errors.filter((e) => !e.bucket).map((e) => e.profile));
  const exitCode = failedProfiles.size === profiles.length ? 1 : 0;

  if (options.json) {
    const result = { profiles, profileSource: source, configFiles, targets, errors };
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return exitCode;
  }

  if (targets.length) {
    stdout(`${formatTargetsTable(targets, { paintProd: chalk.red })}\n`);
  } else if (!exitCode) {
    stdout('No WordPress clusters found.\n');
  }
  for (const error of errors) {
    const where = [error.profile ?? '(default)', error.bucket].filter(Boolean).join(' ');
    stderr(`${chalk.yellow('Warning:')} ${where}: ${error.message}\n`);
    if (error.hint) {
      stderr(`  ${error.hint}\n`);
    }
  }
  return exitCode;
}
