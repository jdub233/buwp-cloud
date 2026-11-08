/**
 * Finding one target by name.
 *
 * A target's name is its stack name, <STACK_ID>-<Landscape>, which is also the prefix of its
 * ContextLog bucket. So a lookup lists the buckets and reads only the matching context, instead of
 * every context the way `clusters` does.
 */

import { discoverTargets } from './discovery.js';

/** A target lookup that didn't produce exactly one target. */
export class TargetError extends Error {
  /**
   * @param {string} message
   * @param {{suggestions?: string[], matches?: object[], errors?: object[]}} details
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'TargetError';
    this.suggestions = details.suggestions ?? [];
    this.matches = details.matches ?? [];
    this.errors = details.errors ?? [];
  }
}

const CLUSTER_OR_SERVICE_NAME = /^(?<stackId>.+)-wp-(?:cluster|service)-(?<landscape>.+)$/;

/**
 * Turn what someone typed into a stack name. Accepts the ECS cluster or service name too, since
 * those are what runbooks and the AWS console show.
 * @param {string} name
 * @returns {string}
 */
export function normalizeTargetName(name) {
  const trimmed = String(name).trim();
  const match = CLUSTER_OR_SERVICE_NAME.exec(trimmed);
  return match ? `${match.groups.stackId}-${match.groups.landscape}` : trimmed;
}

/**
 * Find exactly one target.
 * @param {string} name - Target (stack) name, or its ECS cluster or service name
 * @param {object} opts
 * @param {(string|null)[]} opts.profiles - Profiles to search, from resolveProfiles()
 * @param {string} opts.source - Where the profiles came from, for the not-found message
 * @param {object} opts.aws - The AWS adapter
 * @returns {Promise<{target: object, errors: object[]}>} errors lists profiles that couldn't be
 *   searched; they don't matter once the target is found, but callers may report them.
 * @throws {TargetError} When no target or more than one matches
 */
export async function findTarget(name, { profiles, source, aws }) {
  const stackName = normalizeTargetName(name);
  const { targets: matches, errors } = await discoverTargets({ profiles, aws, stackName });

  if (matches.length === 1) {
    return { target: matches[0], errors };
  }

  if (matches.length > 1) {
    const where = matches.map((t) => `${t.profile ?? '(default)'} ${t.region}`).join(', ');
    throw new TargetError(
      `"${stackName}" exists in more than one place (${where}). Choose one with --profile.`,
      { matches, errors }
    );
  }

  // Not found. Suggest real targets: list them all and keep the ones that contain what was typed.
  const { targets } = await discoverTargets({ profiles, aws });
  const names = targets.map((t) => t.name);
  const close = names.filter((n) => n.includes(stackName));
  const searched = profiles.map((p) => p ?? '(default)').join(', ');
  const from = { flag: 'from --profile', env: 'from AWS_PROFILE', config: 'from the config file' }[source];
  throw new TargetError(
    `No target named "${stackName}" in ${searched}${from ? ` (${from})` : ''}.`,
    { suggestions: close.length ? close : names, errors }
  );
}
