/**
 * clusters: list the WordPress clusters your AWS profiles can reach.
 */

import chalk from 'chalk';
import { loadConfig, resolveProfiles } from '../config.js';
import { discoverTargets } from '../discovery.js';
import { credentialHint, describeError } from '../errors.js';
import { createAwsAdapter } from '../aws.js';
import { formatTable, formatJobRunner } from '../format.js';

const COLUMNS = ['TARGET', 'PROD', 'ENVIRONMENT', 'REGION', 'JOB RUNNER'];
const PROD_COLUMN = 1;
const DEFAULT_CHAIN = '(default credential chain)';

const targetRow = (t) => [
  t.name,
  t.production ? 'yes' : 'no',
  t.environmentType ?? 'unset',
  t.region ?? '-',
  formatJobRunner(t.jobRunner),
];

/**
 * Group targets by the profile that found them, in the order the profiles were searched. A
 * profile whose search failed outright is left out; its warning says why.
 * @param {(string|null)[]} profiles - As searched; null is the default credential chain
 * @param {object[]} targets
 * @param {Set<string|null>} failedProfiles
 * @returns {{profile: string|null, account: string|null, sameAs: string|null, targets: object[]}[]}
 *   sameAs names an earlier profile that reaches the same account.
 */
export function groupByProfile(profiles, targets, failedProfiles = new Set()) {
  const firstProfileFor = new Map();
  return profiles.filter((profile) => !failedProfiles.has(profile)).map((profile) => {
    const own = targets.filter((t) => t.profile === profile);
    const account = own.find((t) => t.account)?.account ?? null;
    let sameAs = null;
    if (account && firstProfileFor.has(account)) {
      sameAs = firstProfileFor.get(account) ?? DEFAULT_CHAIN;
    } else if (account) {
      firstProfileFor.set(account, profile);
    }
    return { profile, account, sameAs, targets: own };
  });
}

/**
 * Render each profile's targets as a table under a heading naming the profile and its account.
 * The tables share column widths, so they line up.
 * @param {ReturnType<typeof groupByProfile>} groups
 * @param {{paintProd?: (s: string) => string, paintHeading?: (s: string) => string}} options -
 *   paintProd styles the PROD cell of production targets, after padding so escape codes don't
 *   throw off alignment.
 * @returns {string}
 */
export function formatClusterGroups(groups, { paintProd = (s) => s, paintHeading = (s) => s } = {}) {
  const allRows = groups.flatMap((g) => g.targets.map(targetRow));
  const widths = COLUMNS.map((header, i) => Math.max(header.length, ...allRows.map((row) => row[i].length)));
  const indent = (text) => text.split('\n').map((line) => `  ${line}`).join('\n');

  return groups.map(({ profile, account, sameAs, targets }) => {
    const details = [account && `account ${account}`, sameAs && `same account as ${sameAs}`].filter(Boolean);
    const heading = paintHeading(profile ?? DEFAULT_CHAIN) + (details.length ? ` (${details.join(', ')})` : '');
    if (!targets.length) {
      return `${heading}\n  No WordPress clusters.`;
    }
    const table = formatTable(COLUMNS, targets.map(targetRow), {
      widths,
      paint: (cell, r, c) => (c === PROD_COLUMN && targets[r].production ? paintProd(cell) : cell),
    });
    return `${heading}\n${indent(table)}`;
  }).join('\n\n');
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
    const groups = groupByProfile(profiles, targets, failedProfiles);
    stdout(`${formatClusterGroups(groups, { paintProd: chalk.red, paintHeading: chalk.bold })}\n`);
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
