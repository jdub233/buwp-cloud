/**
 * Shared test fixtures.
 *
 * Made-up values only: this repo carries no real account IDs, stack names, hostnames or profiles.
 * The shapes follow what bu-wp-ecs and its sibling stacks actually write to their context buckets.
 */

export const ACCOUNT = '123456789012';

/** A bu-wp-ecs WordPress context, with overrides merged at the top level. */
export function wordpressContext(overrides = {}) {
  return {
    STACK_ID: 'wp-x',
    ACCOUNT,
    REGION: 'us-east-1',
    TYPE: 'cloudfront',
    PREFIXES: { wordpress: 'wp', s3proxy: 's3proxy', rds: 'rds' },
    S3PROXY: { dockerImage: 'example/s3proxy:latest' },
    WORDPRESS: {
      dockerImage: 'example/wordpress:latest',
      env: { environmentType: 'development' },
    },
    TAGS: { Service: 'example', Function: 'example', Landscape: 'example-test' },
    JOBRUNNER: { schedule: 'rate(5 minutes)' },
    DNS: { subdomain: 'wp-example-test.example.edu' },
    ...overrides,
  };
}

/** The context of an edge (Shibboleth) stack that shares the bucket naming pattern. */
export function edgeContext() {
  return {
    STACK_ID: 'shib-x',
    ACCOUNT,
    REGION: 'us-east-1',
    SHIBBOLETH: {},
    ORIGIN: {},
    TAGS: { Landscape: 'example-test' },
  };
}

/** The ContextLog bucket name for a stack name. */
export function contextBucket(stackName, region = 'us-east-1') {
  return `${stackName}-context-config-${ACCOUNT}-${region}`;
}

/**
 * A fake AWS adapter.
 * @param {Record<string, {buckets?: Record<string, unknown>, error?: Error}>} byProfile - Per
 *   profile, either an error for listBucketNames or a map of bucket name to its context. A context
 *   that is an Error is thrown by getJson. Use the key "null" for the default chain.
 */
export function fakeAws(byProfile) {
  const calls = [];
  return {
    calls,
    async listBucketNames(profile) {
      calls.push(['listBucketNames', profile]);
      const entry = byProfile[String(profile)];
      if (entry.error) {
        throw entry.error;
      }
      return Object.keys(entry.buckets);
    },
    async getJson(profile, bucket, key, region) {
      calls.push(['getJson', profile, bucket, key, region]);
      const value = byProfile[String(profile)].buckets[bucket];
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
  };
}

/** An error shaped like an AWS SDK service exception. */
export function awsError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}
