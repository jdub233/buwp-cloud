/**
 * The AWS profiles set up on this machine, by name.
 *
 * Profiles are read from the AWS CLI's shared files, `~/.aws/config` and `~/.aws/credentials`
 * (or the files AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE name). Only section headers and
 * key names are read, never values, so no key or token goes anywhere through this module.
 *
 * Key names matter for one case: a profile with `credential_process` runs a program to get its
 * credentials, and that program can start an interactive login. Callers can skip checking it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Where the AWS CLI's shared files are.
 * @param {{env?: NodeJS.ProcessEnv, homedir?: string}} opts
 * @returns {{config: string, credentials: string}}
 */
export function sharedFilePaths({ env = process.env, homedir = os.homedir() } = {}) {
  return {
    config: env.AWS_CONFIG_FILE || path.join(homedir, '.aws', 'config'),
    credentials: env.AWS_SHARED_CREDENTIALS_FILE || path.join(homedir, '.aws', 'credentials'),
  };
}

/**
 * The sections of an ini file: each header's name, and the names of the keys under it.
 * @param {string} text
 * @returns {{name: string, keys: string[]}[]}
 */
export function iniSections(text) {
  const sections = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const header = line.match(/^\[\s*([^\]]*?)\s*\]/);
    if (header) {
      current = { name: header[1], keys: [] };
      sections.push(current);
    } else if (current) {
      // The key's name only; what follows the = is never looked at.
      const key = line.match(/^([^=\s]+)\s*=/);
      if (key) {
        current.keys.push(key[1].toLowerCase());
      }
    }
  }
  return sections;
}

/**
 * The profile a section of the config file defines: `[default]` or `[profile <name>]`. Other
 * sections (`[sso-session …]`, `[services …]`) aren't profiles.
 * @param {string} section
 * @returns {string|null}
 */
export function profileFromConfigSection(section) {
  if (section === 'default') {
    return 'default';
  }
  const match = section.match(/^profile\s+(\S.*)$/);
  return match ? match[1].trim() : null;
}

/**
 * Every profile named in the shared files: config file first, in file order, then any that only
 * the credentials file has. A missing file is skipped.
 * @param {{env?: NodeJS.ProcessEnv, homedir?: string, readFile?: (file: string) => string}} opts
 * @returns {{profiles: {name: string, files: ('config'|'credentials')[], credentialProcess: boolean}[],
 *   files: string[]}} files lists the shared files that exist
 */
export function listAwsProfiles({
  env = process.env,
  homedir = os.homedir(),
  readFile = (file) => fs.readFileSync(file, 'utf8'),
} = {}) {
  const paths = sharedFilePaths({ env, homedir });
  const byName = new Map();
  const files = [];
  for (const kind of ['config', 'credentials']) {
    let text;
    try {
      text = readFile(paths[kind]);
    } catch (err) {
      if (err.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
    files.push(paths[kind]);
    for (const section of iniSections(text)) {
      const name = kind === 'config' ? profileFromConfigSection(section.name) : section.name;
      if (!name) {
        continue;
      }
      const profile = byName.get(name) ?? { name, files: [], credentialProcess: false };
      if (!profile.files.includes(kind)) {
        profile.files.push(kind);
      }
      profile.credentialProcess ||= section.keys.includes('credential_process');
      byName.set(name, profile);
    }
  }
  return { profiles: [...byName.values()], files };
}
