/**
 * config: show, create or check the .buwp-cloud.json config file.
 * Mirrors buwp-local's `config --show / --init / --validate`.
 */

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { CONFIG_FILE_NAME, loadConfig, resolveProfiles } from '../config.js';
import { describeError } from '../errors.js';

const SOURCE_LABELS = {
  flag: 'from --profile',
  env: 'from AWS_PROFILE, which overrides the config file',
  config: 'from the config file',
  default: 'the AWS SDK default credential chain',
};

/**
 * @param {{show?: boolean, init?: boolean, validate?: boolean, profile?: string[],
 *   force?: boolean, json?: boolean}} options - With none of show/init/validate, shows.
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code
 */
export default async function configCommand(options = {}, {
  env = process.env,
  cwd = process.cwd(),
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
} = {}) {
  const io = { env, cwd, stdout, stderr };
  try {
    if (options.init) {
      return init(options, io);
    }
    if (options.validate) {
      return validate(io);
    }
    return show(options, io);
  } catch (err) {
    stderr(`${chalk.red('Error:')} ${describeError(err)}\n`);
    return 1;
  }
}

function show(options, { env, cwd, stdout }) {
  const loaded = loadConfig({ env, cwd });
  const { profiles, source } = resolveProfiles({ env, readConfig: () => loaded });

  if (options.json) {
    const result = { configFiles: loaded.files, config: loaded.config, profiles, profileSource: source };
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const files = loaded.files.length
    ? loaded.files.join(`\n${' '.repeat(14)}`)
    : `none found (looked in ${cwd} and its parents)`;
  const names = profiles[0] === null ? '-' : profiles.join(', ');
  stdout(`Config file:  ${files}\n`);
  stdout(`Profiles:     ${names}  (${SOURCE_LABELS[source]})\n`);
  return 0;
}

function init(options, { env, cwd, stdout, stderr }) {
  const profiles = options.profile?.length
    ? [...new Set(options.profile)]
    : env.AWS_PROFILE ? [env.AWS_PROFILE] : [];
  if (!profiles.length) {
    stderr(`${chalk.red('Error:')} Name the AWS profiles to search: `
      + 'buwp-cloud config --init --profile <name> [--profile <name>]\n');
    return 1;
  }

  const file = path.join(cwd, CONFIG_FILE_NAME);
  if (fs.existsSync(file) && !options.force) {
    stderr(`${chalk.red('Error:')} ${file} already exists. Use --force to replace it.\n`);
    return 1;
  }

  fs.writeFileSync(file, `${JSON.stringify({ profiles }, null, 2)}\n`);
  stdout(`${chalk.green('Created')} ${file} with profiles: ${profiles.join(', ')}\n`);
  stdout(chalk.gray('It names AWS profiles, so keep it out of public repos (add it to .gitignore).\n'));
  return 0;
}

function validate({ env, cwd, stdout }) {
  const { files } = loadConfig({ env, cwd });
  stdout(files.length
    ? `${chalk.green('Valid:')} ${files.join(', ')}\n`
    : `No config file found in ${cwd} or its parents.\n`);
  return 0;
}
