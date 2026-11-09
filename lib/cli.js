/**
 * Shared steps for commands that act on one target: resolve the profiles, find the target, and
 * report failures the same way everywhere.
 */

import chalk from 'chalk';
import { loadConfig, resolveProfiles } from './config.js';
import { findTarget, TargetError } from './targets.js';
import { credentialHint, describeError, errorCode } from './errors.js';

/**
 * Write an error, with an optional indented hint on the next line.
 * @param {(s: string) => void} stderr
 * @param {string} message
 * @param {string|null} [hint]
 * @returns {1} The exit code, so callers can `return reportError(...)`
 */
export function reportError(stderr, message, hint = null) {
  stderr(`${chalk.red('Error:')} ${message}\n`);
  if (hint) {
    stderr(`  ${hint}\n`);
  }
  return 1;
}

/**
 * Report an AWS call that failed while working on a target, with a credential hint if it is one.
 * @returns {1}
 */
export function reportAwsError(stderr, err, { profile, source }) {
  return reportError(stderr, describeError(err), credentialHint({ code: errorCode(err), profile }, { source }));
}

/**
 * Resolve profiles and find the named target, reporting any failure.
 * @param {string} name - Target name, or its ECS cluster or service name
 * @param {{profile?: string[]}} options - Command options; `profile` holds --profile flags
 * @param {{aws: object, env: NodeJS.ProcessEnv, readConfig?: Function, stderr: Function}} deps
 * @returns {Promise<{target: object, source: string}|null>} null when it failed and was reported
 */
export async function loadTarget(name, options, { aws, env, readConfig = () => loadConfig({ env }), stderr }) {
  let profiles, source;
  try {
    ({ profiles, source } = resolveProfiles({ cliProfiles: options.profile ?? [], env, readConfig }));
  } catch (err) {
    reportError(stderr, describeError(err));
    return null;
  }

  try {
    const { target } = await findTarget(name, { profiles, source, aws });
    return { target, source };
  } catch (err) {
    if (!(err instanceof TargetError)) {
      reportError(stderr, describeError(err));
      return null;
    }
    reportError(stderr, err.message);
    if (err.suggestions.length) {
      stderr(`  Targets: ${err.suggestions.join(', ')}\n`);
    }
    for (const e of err.errors.filter((e) => !e.bucket)) {
      stderr(`  Couldn't search ${e.profile ?? '(default)'}: ${e.message}\n`);
      const hint = credentialHint(e, { source });
      if (hint) {
        stderr(`  ${hint}\n`);
      }
    }
    return null;
  }
}
