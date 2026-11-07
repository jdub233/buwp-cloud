/**
 * The thin AWS layer.
 *
 * It only turns a profile and a region into SDK calls. Everything BU-specific lives in the modules
 * that call it, which take this adapter as a parameter so tests can pass a fake.
 */

import { S3Client, GetObjectCommand, paginateListBuckets } from '@aws-sdk/client-s3';

// ListBuckets covers the whole account, so any region can answer it; this only picks the endpoint.
const ACCOUNT_WIDE_REGION = 'us-east-1';

/**
 * @returns {{
 *   listBucketNames: (profile: string|null) => Promise<string[]>,
 *   getJson: (profile: string|null, bucket: string, key: string, region: string) => Promise<unknown>,
 * }}
 */
export function createAwsAdapter() {
  const clients = new Map();

  // A null profile leaves the SDK on its default credential chain.
  function s3(profile, region) {
    const key = `${profile ?? ''}|${region}`;
    if (!clients.has(key)) {
      clients.set(key, new S3Client({ region, ...(profile ? { profile } : {}) }));
    }
    return clients.get(key);
  }

  return {
    async listBucketNames(profile) {
      const names = [];
      const pages = paginateListBuckets({ client: s3(profile, ACCOUNT_WIDE_REGION) }, {});
      for await (const page of pages) {
        for (const bucket of page.Buckets ?? []) {
          names.push(bucket.Name);
        }
      }
      return names;
    },

    async getJson(profile, bucket, key, region) {
      const response = await s3(profile, region).send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      return JSON.parse(await response.Body.transformToString());
    },
  };
}
