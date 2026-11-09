/**
 * The thin AWS layer.
 *
 * It only turns a profile and a region into SDK calls. Everything BU-specific lives in the modules
 * that call it, which take this adapter as a parameter so tests can pass a fake.
 */

import { S3Client, GetObjectCommand, paginateListBuckets } from '@aws-sdk/client-s3';
import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  paginateListTasks,
} from '@aws-sdk/client-ecs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// ListBuckets covers the whole account, so any region can answer it; this only picks the endpoint.
const ACCOUNT_WIDE_REGION = 'us-east-1';

// DescribeTasks accepts at most this many tasks per call.
const DESCRIBE_TASKS_LIMIT = 100;

export function createAwsAdapter() {
  const clients = new Map();

  // One client per service, profile and region. A null profile leaves the SDK on its default
  // credential chain.
  function client(Client, profile, region) {
    const key = `${Client.name}|${profile ?? ''}|${region}`;
    if (!clients.has(key)) {
      clients.set(key, new Client({ region, ...(profile ? { profile } : {}) }));
    }
    return clients.get(key);
  }

  return {
    /** @returns {Promise<string[]>} */
    async listBucketNames(profile) {
      const names = [];
      const pages = paginateListBuckets({ client: client(S3Client, profile, ACCOUNT_WIDE_REGION) }, {});
      for await (const page of pages) {
        for (const bucket of page.Buckets ?? []) {
          names.push(bucket.Name);
        }
      }
      return names;
    },

    /** @returns {Promise<unknown>} The parsed JSON object */
    async getJson(profile, bucket, key, region) {
      const response = await client(S3Client, profile, region).send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      return JSON.parse(await response.Body.transformToString());
    },

    /** @returns {Promise<object|null>} The service, or null when ECS reports it missing */
    async describeService(profile, region, cluster, service) {
      const response = await client(ECSClient, profile, region).send(
        new DescribeServicesCommand({ cluster, services: [service] })
      );
      return response.services?.[0] ?? null;
    },

    /** @returns {Promise<string[]>} ARNs of the service's tasks whose desired status is RUNNING */
    async listServiceTasks(profile, region, cluster, service) {
      const arns = [];
      const pages = paginateListTasks(
        { client: client(ECSClient, profile, region) },
        { cluster, serviceName: service, desiredStatus: 'RUNNING' }
      );
      for await (const page of pages) {
        arns.push(...(page.taskArns ?? []));
      }
      return arns;
    },

    /** @returns {Promise<object[]>} */
    async describeTasks(profile, region, cluster, taskArns) {
      const tasks = [];
      for (let i = 0; i < taskArns.length; i += DESCRIBE_TASKS_LIMIT) {
        const response = await client(ECSClient, profile, region).send(
          new DescribeTasksCommand({ cluster, tasks: taskArns.slice(i, i + DESCRIBE_TASKS_LIMIT) })
        );
        tasks.push(...(response.tasks ?? []));
      }
      return tasks;
    },

    /** @returns {Promise<object>} */
    async describeTaskDefinition(profile, region, taskDefinition) {
      const response = await client(ECSClient, profile, region).send(
        new DescribeTaskDefinitionCommand({ taskDefinition })
      );
      return response.taskDefinition;
    },

    /** @returns {Promise<string>} The secret's string value */
    async getSecretString(profile, region, secretId, { versionStage, versionId } = {}) {
      const response = await client(SecretsManagerClient, profile, region).send(
        new GetSecretValueCommand({
          SecretId: secretId,
          ...(versionStage ? { VersionStage: versionStage } : {}),
          ...(versionId ? { VersionId: versionId } : {}),
        })
      );
      if (response.SecretString === undefined) {
        throw new Error('The secret has no string value');
      }
      return response.SecretString;
    },
  };
}
