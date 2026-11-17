/**
 * init: choose the AWS profiles buwp-cloud searches for targets, and where to save the choice.
 *
 * Mirrors buwp-local's `init`: menus (prompts) in a terminal, and a non-interactive path for
 * scripts and agents (`--no-interactive`, `--profile`, or no terminal), which saves the named
 * profiles the way `config --init` does.
 *
 * The menu lists the profiles named in the AWS CLI's shared files (awsprofiles.js: names only,
 * never keys or tokens) and says what each one reaches, using the same discovery as `clusters`.
 * Profiles that reach targets start selected, except one whose account an earlier profile already
 * reaches: with two profiles on one account, every target there would be found twice.
 */

import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import prompts from 'prompts';
import {
  CONFIG_FILE_NAME, OVERRIDE_FILE_NAME, CONFIG_ENV_VAR, loadConfig, findConfigDir, writeProfiles,
} from '../config.js';
import { listAwsProfiles } from '../awsprofiles.js';
import { discoverTargets, parseContextBucketName } from '../discovery.js';
import { credentialProblem, describeError } from '../errors.js';
import { createAwsAdapter } from '../aws.js';
import { checkTools, TESTED_PLUGIN_VERSION } from '../tools.js';
import configCommand from './config.js';

class Cancelled extends Error {}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A path under the home directory, written with ~. */
function tildify(file, homedir) {
  const rel = path.relative(homedir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join('~', rel) : file;
}

/** The account a target lives in, from its context or else its bucket's name. */
function accountOf(target) {
  return target.account ?? parseContextBucketName(target.contextBucket ?? '')?.account ?? null;
}

/**
 * Check what each profile reaches, all at once. A profile that runs a credential_process isn't
 * checked, since the process could start a login.
 * @param {{name: string, credentialProcess?: boolean}[]} profiles
 * @param {{aws: object}} deps
 * @returns {Promise<{name: string, checked: boolean, targets: object[], accounts: string[],
 *   error: object|null, unreadable: number}[]>} error is a failure of the whole profile;
 *   unreadable counts context files it couldn't read
 */
export async function surveyProfiles(profiles, { aws }) {
  const names = profiles.filter((p) => !p.credentialProcess).map((p) => p.name);
  const { targets, errors } = names.length
    ? await discoverTargets({ profiles: names, aws })
    : { targets: [], errors: [] };
  return profiles.map(({ name, credentialProcess }) => {
    const mine = targets.filter((t) => t.profile === name);
    return {
      name,
      checked: !credentialProcess,
      targets: mine,
      accounts: [...new Set(mine.map(accountOf).filter(Boolean))],
      error: errors.find((e) => e.profile === name && !e.bucket) ?? null,
      unreadable: errors.filter((e) => e.profile === name && e.bucket).length,
    };
  });
}

/**
 * Decide what starts selected, and mark profiles whose account another profile already reaches.
 * Accounts go first to profiles in the current config, then named profiles, then `default`.
 * @param {object[]} survey - From surveyProfiles()
 * @param {{current?: string[]}} opts - The profiles in the config file that applies now
 * @returns {object[]} The survey entries, each with sameAs (a profile name or null) and selected
 */
export function planChoices(survey, { current = [] } = {}) {
  const rank = (s) => {
    if (current.includes(s.name)) {
      return 0;
    }
    return s.name === 'default' ? 2 : 1;
  };
  const owners = new Map();
  const sameAs = new Map();
  for (const s of [...survey].sort((a, b) => rank(a) - rank(b))) {
    const shared = s.accounts.find((a) => owners.has(a));
    if (shared) {
      sameAs.set(s.name, owners.get(shared));
    } else {
      s.accounts.forEach((a) => owners.set(a, s.name));
    }
  }
  return survey.map((s) => ({
    ...s,
    sameAs: sameAs.get(s.name) ?? null,
    selected: current.includes(s.name) || (s.targets.length > 0 && !sameAs.has(s.name)),
  }));
}

/**
 * What a profile reaches, in a few words for the menu.
 * @param {object} s - An entry from planChoices()
 * @returns {string}
 */
export function describeReach(s) {
  if (s.missing) {
    return 'in the config file, but not in your AWS files';
  }
  if (!s.checked) {
    return 'not checked: it runs a credential_process';
  }
  if (s.error) {
    const problem = credentialProblem(s.error.code);
    if (problem) {
      return problem === 'expired' ? 'credentials expired' : 'no valid credentials';
    }
    const message = s.error.message.length > 60 ? `${s.error.message.slice(0, 59)}…` : s.error.message;
    return `couldn't check: ${message}`;
  }
  if (s.sameAs) {
    return `same account as ${s.sameAs}`;
  }
  if (!s.targets.length) {
    return s.unreadable
      ? `no WordPress targets it could read (${plural(s.unreadable, 'context file')} unreadable)`
      : 'no WordPress targets';
  }
  const prod = s.targets.filter((t) => t.production).length;
  const split = [s.targets.length - prod ? `${s.targets.length - prod} nonprod` : null, prod ? `${prod} prod` : null];
  return `${plural(s.targets.length, 'WordPress target')}: ${split.filter(Boolean).join(', ')}`;
}

/** The first two chosen profiles that reach the same account, or null. */
function findClash(chosen) {
  const owners = new Map();
  for (const s of chosen) {
    for (const account of s.accounts) {
      if (owners.has(account) && owners.get(account) !== s.name) {
        return [owners.get(account), s.name];
      }
      owners.set(account, s.name);
    }
  }
  return null;
}

/** Whether git ignores a file: null when git isn't there or the file isn't in a repo. */
function isGitIgnored(file) {
  const result = spawnSync('git', ['check-ignore', '-q', file], { cwd: path.dirname(file) });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return null;
  }
  return result.status === 0;
}

/**
 * Things worth knowing about where the file went: what else decides which file is read, and
 * whether git would commit it.
 * @returns {string[]}
 */
export function placementNotes(file, { env, cwd, homedir, gitIgnored }) {
  const notes = [];
  const home = (p) => tildify(p, homedir);
  const dir = path.dirname(file);
  const override = path.join(dir, OVERRIDE_FILE_NAME);
  if (fs.existsSync(override)) {
    try {
      if (JSON.parse(fs.readFileSync(override, 'utf8'))?.profiles) {
        notes.push(`${home(override)} also lists profiles, and it wins over ${CONFIG_FILE_NAME}.`);
      }
    } catch {
      notes.push(`${home(override)} isn't valid JSON, so every command will stop on it.`);
    }
  }
  if (path.resolve(dir) === path.resolve(homedir)) {
    const rel = path.relative(homedir, cwd);
    const closer = findConfigDir(cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      notes.push(`It isn't used from ${cwd}, which is outside your home directory.`);
    } else if (closer && path.resolve(closer) !== path.resolve(homedir)) {
      notes.push(`${home(closer)} has a config file of its own, which is the one used there.`);
    }
  } else if (gitIgnored(file) === false) {
    notes.push(`${home(file)} names AWS profiles and isn't gitignored. Add it to .gitignore, `
      + 'unless this is a private repo meant to share it.');
  }
  if (env[CONFIG_ENV_VAR]) {
    notes.push(`${CONFIG_ENV_VAR} is set, so buwp-cloud reads ${env[CONFIG_ENV_VAR]} instead.`);
  }
  if (env.AWS_PROFILE) {
    notes.push(`AWS_PROFILE is set (${env.AWS_PROFILE}), and it overrides the config file while it's set.`);
  }
  return notes;
}

/**
 * @param {{interactive?: boolean, profile?: string[], home?: boolean, force?: boolean}} options -
 *   interactive is false for --no-interactive
 * @param {object} deps - Overridable for tests
 * @returns {Promise<number>} Exit code
 */
export default async function initCommand(options = {}, {
  aws,
  env = process.env,
  cwd = process.cwd(),
  homedir = os.homedir(),
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
  terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt = prompts,
  readProfiles = () => listAwsProfiles({ env, homedir }),
  tools = () => checkTools(),
  gitIgnored = isGitIgnored,
} = {}) {
  if (options.interactive === false || options.profile?.length || !terminal) {
    if (!options.profile?.length && !env.AWS_PROFILE) {
      const why = terminal ? '' : "init's menus need a terminal. ";
      stderr(`${chalk.red('Error:')} ${why}Name the AWS profiles to save: `
        + 'buwp-cloud init --no-interactive --profile <name> [--profile <name>] [--home]\n');
      return 1;
    }
    return configCommand(
      { init: true, profile: options.profile, force: options.force },
      { env, cwd: options.home ? homedir : cwd, stdout, stderr }
    );
  }

  const ask = async (question) => {
    let cancelled = false;
    const answers = await prompt(question, { onCancel: () => { cancelled = true; return false; } });
    if (cancelled || !answers || !(question.name in answers)) {
      throw new Cancelled();
    }
    return answers[question.name];
  };

  try {
    return await runMenus({
      aws: aws ?? createAwsAdapter(), env, cwd, homedir, stdout, stderr, ask, readProfiles, tools, gitIgnored,
    });
  } catch (err) {
    if (err instanceof Cancelled) {
      stderr(chalk.gray('Cancelled. Nothing was written.\n'));
      return 1;
    }
    stderr(`${chalk.red('Error:')} ${describeError(err)}\n`);
    return 1;
  }
}

async function runMenus({ aws, env, cwd, homedir, stdout, stderr, ask, readProfiles, tools, gitIgnored }) {
  const home = (p) => tildify(p, homedir);
  const { profiles, files } = readProfiles();

  let current = [];
  let currentFiles = [];
  try {
    ({ config: { profiles: current = [] }, files: currentFiles } = loadConfig({ env, cwd }));
  } catch (err) {
    stderr(`${chalk.yellow('Warning:')} ${describeError(err)}. Starting with nothing selected.\n`);
  }

  const missing = current.filter((name) => !profiles.some((p) => p.name === name));
  if (!profiles.length && !missing.length) {
    const where = files.length ? files.map(home).join(' or ') : 'your AWS config or credentials file';
    stderr(`${chalk.red('Error:')} No AWS profiles found in ${where}. `
      + 'Set one up, for example with aws configure, then run init again.\n');
    return 1;
  }

  stderr(chalk.gray(`Checking ${plural(profiles.length, 'AWS profile')} for WordPress targets…\n`));
  const survey = planChoices(await surveyProfiles(profiles, { aws }), { current });
  // Profiles the config names but the AWS files don't stay on the list, selected, so saving
  // doesn't drop them unseen.
  for (const name of missing) {
    survey.push({ name, missing: true, checked: false, targets: [], accounts: [], error: null, unreadable: 0, sameAs: null, selected: true });
  }

  const width = Math.max(...survey.map((s) => s.name.length));
  const listTargets = (targets) => {
    const names = targets.map((t) => t.name);
    return names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
  };
  const selected = await ask({
    type: 'multiselect',
    name: 'profiles',
    message: 'AWS profiles to search for WordPress targets',
    choices: survey.map((s) => ({
      title: `${s.name.padEnd(width)}  ${chalk.gray(describeReach(s))}`,
      value: s.name,
      selected: s.selected,
      ...(s.targets.length ? { description: listTargets(s.targets) } : {}),
    })),
    hint: '- Space to select, Return to continue',
    instructions: false,
    min: 1,
  });

  const clash = findClash(survey.filter((s) => selected.includes(s.name)));
  if (clash) {
    stderr(`${chalk.yellow('Warning:')} ${clash[0]} and ${clash[1]} reach the same AWS account, so each `
      + 'target there would be found twice, and commands would ask which profile you mean.\n');
    if (!(await ask({ type: 'confirm', name: 'keep', message: 'Save both anyway?', initial: false }))) {
      throw new Cancelled();
    }
  }

  const localFile = path.join(cwd, CONFIG_FILE_NAME);
  const homeFile = path.join(homedir, CONFIG_FILE_NAME);
  let file = localFile;
  if (path.resolve(cwd) !== path.resolve(homedir)) {
    file = await ask({
      type: 'select',
      name: 'file',
      message: 'Where should the config file go?',
      choices: [
        { title: `This directory   ${home(localFile)}`, value: localFile, description: 'Used here and in the directories below' },
        { title: `Home directory   ${home(homeFile)}`, value: homeFile, description: 'Used anywhere under your home directory that has no closer config file' },
      ],
      initial: currentFiles.includes(homeFile) ? 1 : 0,
    });
  }

  const saved = writeProfiles(file, selected);
  stdout(`${chalk.green(saved === 'created' ? 'Created' : 'Updated')} ${home(file)} with profiles: ${selected.join(', ')}\n`);
  for (const note of placementNotes(file, { env, cwd, homedir, gitIgnored })) {
    stderr(`${chalk.yellow('Note:')} ${note}\n`);
  }

  const chosen = survey.filter((s) => selected.includes(s.name));
  const reached = chosen.reduce((n, s) => n + s.targets.length, 0);
  const waiting = chosen.some((s) => s.error);
  if (reached) {
    stdout(`They reach ${plural(reached, 'WordPress target')}${waiting ? ' so far' : ''}. List them with: buwp-cloud clusters\n`);
  } else {
    stdout(`${waiting ? 'Once their credentials are fresh, list' : 'List'} their targets with: buwp-cloud clusters\n`);
  }

  reportTools(tools(), stdout);
  return 0;
}

function reportTools(statuses, stdout) {
  stdout('\nSession tools, for shell, exec, cp and db tunnel:\n');
  const width = Math.max(...statuses.map((t) => t.name.length)) + 2;
  for (const t of statuses) {
    let state;
    if (!t.found) {
      state = chalk.yellow(t.problem ? `couldn't run it: ${t.problem}` : 'not found');
    } else if (t.belowTested) {
      state = chalk.yellow(`${t.version}, older than ${TESTED_PLUGIN_VERSION}, the version buwp-cloud is tested with`);
    } else {
      state = t.version ?? 'found';
    }
    stdout(`  ${t.name.padEnd(width)}${state}\n`);
  }
  if (statuses.some((t) => !t.found)) {
    stdout(chalk.gray('  Install AWS CLI v2 and the Session Manager plugin for it (AWS documents both).\n'));
  }
}
