/**
 * Target discovery: find the WordPress clusters an AWS profile can reach.
 *
 * Every bu-wp-ecs stack writes the context it was deployed with to
 *   s3://<STACK_ID>-<Landscape>-context-config-<ACCOUNT>-<REGION>/context.json
 * (bu-wp-ecs: context/ContextLog.ts, and getStackName in lib/Utils.ts). The bucket policy lets any
 * principal in that account read it.
 *
 * Other BU stacks use the same bucket pattern for different context shapes, so a context only
 * counts as a WordPress target when it has a WORDPRESS block. Contexts written before bu-wp-ecs
 * added TYPE don't have one, so nothing here requires it.
 */

import { describeError, errorCode } from './errors.js';

export const CONTEXT_KEY = 'context.json';

const CONTEXT_BUCKET =
  /^(?<stackName>.+)-context-config-(?<account>\d{12})-(?<region>[a-z]{2}(?:-gov)?-[a-z]+-\d+)$/;

// bu-wp-ecs treats every environmentType except these as production. An unset value defaults to
// 'production' in the container (lib/WordpressAppContainerDefConfig.ts), and an unset or unknown
// value gets the production RDS posture (derivePosture in lib/Rds.ts).
const NON_PRODUCTION_TYPES = new Set(['development', 'local', 'staging']);

/**
 * Recognize a ContextLog bucket by name.
 * @param {string} name
 * @returns {{bucket: string, stackName: string, account: string, region: string}|null}
 */
export function parseContextBucketName(name) {
  const match = CONTEXT_BUCKET.exec(name);
  return match ? { bucket: name, ...match.groups } : null;
}

/**
 * Whether a parsed context.json describes a bu-wp-ecs WordPress stack.
 * @param {unknown} context
 * @returns {boolean}
 */
export function isWordpressContext(context) {
  return Boolean(
    context
    && typeof context === 'object'
    && context.WORDPRESS
    && typeof context.WORDPRESS === 'object'
    && typeof context.STACK_ID === 'string'
    && context.STACK_ID !== ''
    && typeof context.TAGS?.Landscape === 'string'
    && context.TAGS.Landscape !== ''
  );
}

/**
 * Whether bu-wp-ecs would treat this stack as production.
 * @param {object} context - A WordPress context
 * @returns {boolean}
 */
export function isProduction(context) {
  return !NON_PRODUCTION_TYPES.has(context?.WORDPRESS?.env?.environmentType);
}

/**
 * Build a target from a WordPress context.
 * @param {object} context - A context for which isWordpressContext() is true
 * @param {{profile?: string|null, bucket?: string, region?: string}} source - Where it was found
 * @returns {object}
 */
export function toTarget(context, { profile = null, bucket = null, region = null } = {}) {
  const stackId = context.STACK_ID;
  const landscape = context.TAGS.Landscape;
  const jobRunner = context.JOBRUNNER
    ? { schedule: context.JOBRUNNER.schedule ?? null, enabled: context.JOBRUNNER.enabled !== false }
    : null;

  return {
    name: `${stackId}-${landscape}`,
    profile,
    account: context.ACCOUNT ?? null,
    region: context.REGION ?? region,
    stackId,
    landscape,
    cluster: `${stackId}-wp-cluster-${landscape}`,
    service: `${stackId}-wp-service-${landscape}`,
    type: context.TYPE ?? null,
    environmentType: context.WORDPRESS.env?.environmentType ?? null,
    production: isProduction(context),
    // bu-wp-ecs adds CPU and memory autoscaling for any truthy AUTOSCALING
    // (AdaptableFargateService.ts, setTaskAutoScaling).
    autoscaling: Boolean(context.AUTOSCALING),
    jobRunner,
    host: context.DNS?.subdomain ?? null,
    contextBucket: bucket,
  };
}

/**
 * Discover WordPress targets across AWS profiles.
 *
 * A profile that fails (expired credentials, no access) doesn't stop the others, and neither does
 * one unreadable context file. Both are reported in `errors`.
 * @param {object} opts
 * @param {(string|null)[]} opts.profiles - Profiles to search. null means the default credential chain.
 * @param {object} opts.aws - listBucketNames(profile) and getJson(profile, bucket, key, region),
 *   as in aws.js. Tests pass a fake.
 * @param {string} [opts.stackName] - Only read the context bucket of this stack
 * @returns {Promise<{
 *   targets: object[],
 *   errors: {profile: string|null, bucket?: string, code: string|null, message: string}[],
 * }>}
 */
export async function discoverTargets({ profiles, aws, stackName }) {
  const results = await Promise.all(
    profiles.map((profile) => discoverInProfile(profile, aws, stackName))
  );
  return {
    targets: results.flatMap((r) => r.targets).sort(compareTargets),
    errors: results.flatMap((r) => r.errors),
  };
}

async function discoverInProfile(profile, aws, stackName) {
  let bucketNames;
  try {
    bucketNames = await aws.listBucketNames(profile);
  } catch (err) {
    return { targets: [], errors: [{ profile, code: errorCode(err), message: describeError(err) }] };
  }

  const buckets = bucketNames
    .map(parseContextBucketName)
    .filter((b) => b && (stackName === undefined || b.stackName === stackName));
  const reads = await Promise.allSettled(
    buckets.map(({ bucket, region }) => aws.getJson(profile, bucket, CONTEXT_KEY, region))
  );

  const targets = [];
  const errors = [];
  reads.forEach((read, i) => {
    const { bucket, region } = buckets[i];
    if (read.status === 'rejected') {
      errors.push({ profile, bucket, code: errorCode(read.reason), message: describeError(read.reason) });
    } else if (isWordpressContext(read.value)) {
      targets.push(toTarget(read.value, { profile, bucket, region }));
    }
  });
  return { targets, errors };
}

function compareTargets(a, b) {
  return a.name.localeCompare(b.name) || String(a.profile).localeCompare(String(b.profile));
}
