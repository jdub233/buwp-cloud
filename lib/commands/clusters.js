/**
 * clusters: list the WordPress clusters your AWS profiles can reach.
 */

import chalk from 'chalk';
import { loadConfig, resolveProfiles } from '../config.js';
import { discoverTargets, describeError } from '../discovery.js';
import { createAwsAdapter } from '../aws.js';

const COLUMNS = ['TARGET', 'PROD', 'ENVIRONMENT', 'REGION', 'PROFILE', 'JOB RUNNER'];

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

  const widths = COLUMNS.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length))
  );
  const line = (cells, paint = []) => cells
    .map((cell, i) => (paint[i] ?? ((s) => s))(cell.padEnd(widths[i])))
    .join('  ')
    .trimEnd();

  return [
    line(COLUMNS),
    ...rows.map((row, r) => line(row, targets[r].production ? [undefined, paintProd] : [])),
  ].join('\n');
}

function formatJobRunner(jobRunner) {
  if (!jobRunner) {
    return '-';
  }
  return `${jobRunner.schedule ?? '?'}${jobRunner.enabled ? '' : ' (disabled)'}`;
}

/**
 * @param {{profile?: string[], json?: boolean}} options
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code. 1 when every profile failed or the config is invalid.
 */
export default async function clustersCommand(options = {}, {
  aws,
  readConfig = loadConfig,
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
} = {}) {
  let profiles;
  try {
    profiles = resolveProfiles(options.profile ?? [], readConfig());
  } catch (err) {
    stderr(`${chalk.red('Error:')} ${describeError(err)}\n`);
    return 1;
  }

  const { targets, errors } = await discoverTargets({ profiles, aws: aws ?? createAwsAdapter() });
  const failedProfiles = new Set(errors.filter((e) => !e.bucket).map((e) => e.profile));
  const exitCode = failedProfiles.size === profiles.length ? 1 : 0;

  if (options.json) {
    stdout(`${JSON.stringify({ profiles, targets, errors }, null, 2)}\n`);
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
  }
  return exitCode;
}
