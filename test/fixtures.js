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

/** A task definition ARN for the example stack. */
export function taskDefinitionArn(revision = 2) {
  return `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/wp-x-wp:${revision}`;
}

/**
 * An ECS task as DescribeTasks returns it. The s3proxy container comes first, as the real API
 * returns it, so tests catch code that takes the first container instead of naming `wordpress`.
 */
export function ecsTask({
  id, revision = 2, startedAt = '2026-01-01T00:00:00Z', lastStatus = 'RUNNING',
  exec = true, agent = 'RUNNING', wordpress = true, wordpressStatus = lastStatus,
} = {}) {
  const agents = (status) => (status ? [{ name: 'ExecuteCommandAgent', lastStatus: status }] : []);
  return {
    taskArn: `arn:aws:ecs:us-east-1:${ACCOUNT}:task/wp-x-wp-cluster-example-test/${id}`,
    taskDefinitionArn: taskDefinitionArn(revision),
    lastStatus,
    startedAt,
    enableExecuteCommand: exec,
    containers: [
      { name: 's3proxy', lastStatus: 'RUNNING', runtimeId: `${id}-s3proxy`, managedAgents: agents('RUNNING') },
      ...(wordpress
        ? [{ name: 'wordpress', lastStatus: wordpressStatus, runtimeId: `${id}-wordpress`, managedAgents: agents(agent) }]
        : []),
    ],
  };
}

/** An ECS service as DescribeServices returns it, with one PRIMARY deployment. */
export function ecsService({ desired = 1, running = 1, revision = 2 } = {}) {
  return {
    serviceName: 'wp-x-wp-service-example-test',
    status: 'ACTIVE',
    desiredCount: desired,
    runningCount: running,
    pendingCount: 0,
    enableExecuteCommand: true,
    deployments: [{
      status: 'PRIMARY',
      taskDefinition: taskDefinitionArn(revision),
      rolloutState: 'COMPLETED',
      desiredCount: desired,
      runningCount: running,
      pendingCount: 0,
      failedTasks: 0,
    }],
  };
}

/** The database password reference the example task definition carries. */
export const DB_PASSWORD_REF =
  `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:wp/example-test-AbCdEf:password::`;

/**
 * A task definition with the sidecar listed first, as the real API returns it. The wordpress
 * container carries the database settings bu-wp-ecs sets.
 */
export function ecsTaskDefinition({
  image = 'example/wordpress:7', dbHost = 'db.example.internal:3306', passwordRef = DB_PASSWORD_REF,
} = {}) {
  return {
    containerDefinitions: [
      { name: 's3proxy', image: 'example/s3proxy:latest', environment: [] },
      {
        name: 'wordpress',
        image,
        environment: [
          { name: 'WORDPRESS_DB_USER', value: 'root' },
          ...(dbHost ? [{ name: 'WORDPRESS_DB_HOST', value: dbHost }] : []),
          { name: 'WORDPRESS_DB_NAME', value: 'wp_db' },
        ],
        secrets: passwordRef ? [{ name: 'WORDPRESS_DB_PASSWORD', valueFrom: passwordRef }] : [],
      },
    ],
  };
}

/**
 * A fake AWS adapter.
 * @param {Record<string, {buckets?: Record<string, unknown>, error?: Error}>} byProfile - Per
 *   profile, either an error for listBucketNames or a map of bucket name to its context. A context
 *   that is an Error is thrown by getJson. Use the key "null" for the default chain.
 * @param {{service?: object|null, tasks?: object[], taskDefinitions?: Record<string, object>,
 *   error?: Error, secrets?: Record<string, string|Error>}} ecs - What the ECS and Secrets Manager
 *   calls return, for whichever target is asked about. An error is thrown by describeService.
 *   secrets maps a secret ID to its string, or to an error getSecretString throws.
 */
export function fakeAws(byProfile, ecs = {}) {
  const calls = [];
  return {
    calls,
    async describeService(profile, region, cluster, service) {
      calls.push(['describeService', profile, region, cluster, service]);
      if (ecs.error) {
        throw ecs.error;
      }
      return ecs.service ?? null;
    },
    async listServiceTasks(profile, region, cluster, service) {
      calls.push(['listServiceTasks', profile, region, cluster, service]);
      return (ecs.tasks ?? []).map((t) => t.taskArn);
    },
    async describeTasks(profile, region, cluster, taskArns) {
      calls.push(['describeTasks', profile, region, cluster, taskArns]);
      return (ecs.tasks ?? []).filter((t) => taskArns.includes(t.taskArn));
    },
    async describeTaskDefinition(profile, region, arn) {
      calls.push(['describeTaskDefinition', profile, region, arn]);
      return ecs.taskDefinitions?.[arn];
    },
    async getSecretString(profile, region, secretId, versions) {
      calls.push(['getSecretString', profile, region, secretId, versions]);
      const value = ecs.secrets?.[secretId];
      if (value instanceof Error) {
        throw value;
      }
      if (value === undefined) {
        throw awsError('ResourceNotFoundException', `Secrets Manager can't find ${secretId}`);
      }
      return value;
    },
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

/** A MySQL server greeting: packet header, protocol 10, NUL-terminated version, then more. */
export function mysqlGreeting(version = '8.0.44') {
  return Buffer.concat([
    Buffer.from([0x4a, 0x00, 0x00, 0x00, 10]),
    Buffer.from(version, 'latin1'),
    Buffer.from([0]),
    Buffer.alloc(20, 1),
  ]);
}

/** An error shaped like an AWS SDK service exception. */
export function awsError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}
