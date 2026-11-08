/**
 * Local configuration: which AWS profiles to search for targets.
 *
 * Targets are discovered from AWS (see discovery.js), so the config only says where to look.
 * It follows wp-env's pattern:
 *   .buwp-cloud.json           shared settings, committed in a private repo that uses buwp-cloud
 *   .buwp-cloud.override.json  personal differences, gitignored, merged over the shared file
 *
 * The applicable directory is the nearest one, walking up from the current directory, that holds
 * either file. Nothing further up is merged in. So a repo's own file applies inside it, and
 * ~/.buwp-cloud.json covers everywhere else under your home directory.
 *
 * BUWP_CLOUD_CONFIG names one file explicitly and skips the search.
 *
 * Shape: { "profiles": ["<nonprod profile>", "<prod profile>"] }
 */

import fs from 'fs';
import path from 'path';

export const CONFIG_FILE_NAME = '.buwp-cloud.json';
export const OVERRIDE_FILE_NAME = '.buwp-cloud.override.json';
export const CONFIG_ENV_VAR = 'BUWP_CLOUD_CONFIG';

/**
 * The nearest directory, from `start` upward, that holds a config or override file.
 * @param {string} start
 * @returns {string|null}
 */
export function findConfigDir(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if ([CONFIG_FILE_NAME, OVERRIDE_FILE_NAME].some((name) => fs.existsSync(path.join(dir, name)))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * The config files that apply, in merge order (later wins).
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string}} opts
 * @returns {string[]}
 */
export function findConfigFiles({ env = process.env, cwd = process.cwd() } = {}) {
  if (env[CONFIG_ENV_VAR]) {
    return [env[CONFIG_ENV_VAR]];
  }
  const dir = findConfigDir(cwd);
  if (!dir) {
    return [];
  }
  return [CONFIG_FILE_NAME, OVERRIDE_FILE_NAME]
    .map((name) => path.join(dir, name))
    .filter((file) => fs.existsSync(file));
}

/**
 * Read, validate and merge the config files that apply. No files means an empty config.
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string}} opts
 * @returns {{config: {profiles?: string[]}, files: string[]}}
 */
export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const files = findConfigFiles({ env, cwd });
  const config = {};
  for (const file of files) {
    Object.assign(config, readConfigFile(file));
  }
  return { config, files };
}

function readConfigFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Config file not found: ${file}`);
    }
    throw err;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  const { profiles } = config;
  if (profiles !== undefined
    && !(Array.isArray(profiles) && profiles.every((p) => typeof p === 'string' && p !== ''))) {
    throw new Error(`"profiles" in ${file} must be an array of AWS profile names`);
  }
  return config;
}

/**
 * Decide which AWS profiles to search, with the AWS CLI's precedence: `--profile` flags, then
 * AWS_PROFILE, then the config files, then the SDK's default credential chain.
 *
 * The flags and AWS_PROFILE pick accounts for one command or one shell. The config lists every
 * account to search when neither is given. It's only read then, so a broken config file can't get
 * in the way of an explicit --profile.
 *
 * The default chain is represented by `null` rather than a profile name. Naming a profile makes
 * the AWS SDK skip environment-variable credentials, which would break CI-style setups.
 * @param {object} opts
 * @param {string[]} [opts.cliProfiles] - Values of repeated `--profile` flags
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {() => {config: {profiles?: string[]}, files: string[]}} [opts.readConfig] - As loadConfig
 * @returns {{
 *   profiles: (string|null)[],
 *   source: 'flag'|'env'|'config'|'default',
 *   configFiles: string[],
 * }} configFiles lists the files read, which is none when a flag or AWS_PROFILE decided.
 */
export function resolveProfiles({
  cliProfiles = [],
  env = process.env,
  readConfig = () => loadConfig({ env }),
} = {}) {
  if (cliProfiles.length) {
    return { profiles: [...new Set(cliProfiles)], source: 'flag', configFiles: [] };
  }
  if (env.AWS_PROFILE) {
    return { profiles: [env.AWS_PROFILE], source: 'env', configFiles: [] };
  }
  const { config, files } = readConfig();
  if (config.profiles?.length) {
    return { profiles: [...new Set(config.profiles)], source: 'config', configFiles: files };
  }
  return { profiles: [null], source: 'default', configFiles: files };
}
