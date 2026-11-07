/**
 * Local configuration: which AWS profiles to search for targets.
 *
 * Targets are discovered from AWS (see discovery.js), so the only thing kept locally is the list of
 * profiles. The file belongs to the user, not to a project. It's found at, in order:
 *   $BUWP_CLOUD_CONFIG
 *   $XDG_CONFIG_HOME/buwp-cloud/config.json
 *   ~/.config/buwp-cloud/config.json
 *
 * Shape: { "profiles": ["<nonprod profile>", "<prod profile>"] }
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const CONFIG_ENV_VAR = 'BUWP_CLOUD_CONFIG';

/**
 * Where the config file is expected, whether or not it exists.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function configPath(env = process.env) {
  if (env[CONFIG_ENV_VAR]) {
    return env[CONFIG_ENV_VAR];
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'buwp-cloud', 'config.json');
}

/**
 * Read and validate the config file. A missing file is not an error: it means "no config".
 * @param {NodeJS.ProcessEnv} env
 * @returns {{profiles?: string[]}}
 */
export function loadConfig(env = process.env) {
  const file = configPath(env);

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
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
 * Decide which AWS profiles to search. Precedence: `--profile` flags, then the config file's
 * `profiles`, then the SDK's default credential chain.
 *
 * The default chain is represented by `null` rather than a profile name. Naming a profile makes
 * the AWS SDK skip environment-variable credentials, which would break CI-style setups.
 * @param {string[]} cliProfiles - Values of repeated `--profile` flags
 * @param {{profiles?: string[]}} config - Result of loadConfig()
 * @returns {(string|null)[]}
 */
export function resolveProfiles(cliProfiles = [], config = {}) {
  if (cliProfiles.length) {
    return [...new Set(cliProfiles)];
  }
  if (config.profiles?.length) {
    return [...new Set(config.profiles)];
  }
  return [null];
}
