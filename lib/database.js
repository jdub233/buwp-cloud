/**
 * The database a target's WordPress container uses, read from its task definition.
 *
 * The task definition is the source because it holds exactly what the app uses: bu-wp-ecs sets
 * WORDPRESS_DB_HOST (host:port), WORDPRESS_DB_USER and WORDPRESS_DB_NAME in the container's
 * environment, and WORDPRESS_DB_PASSWORD as a Secrets Manager reference
 * (lib/WordpressAppContainerDefConfig.ts). Searching RDS cluster names for the stack instead can
 * pick a stale cluster after a recreate.
 */

import { WORDPRESS_CONTAINER } from './tasks.js';

const DEFAULT_MYSQL_PORT = 3306;

/**
 * Split "host:port", falling back to a default port.
 * @param {string} value
 * @param {number} defaultPort
 * @returns {{host: string, port: number}}
 */
export function parseHostPort(value, defaultPort) {
  const match = /^(?<host>.+):(?<port>\d+)$/.exec(value);
  return match
    ? { host: match.groups.host, port: Number(match.groups.port) }
    : { host: value, port: defaultPort };
}

/**
 * The wordpress container's database settings.
 * @param {object} taskDefinition - From DescribeTaskDefinition
 * @returns {{host: string, port: number, user: string|null, name: string|null,
 *   passwordRef: string|null}}
 * @throws When the container or its WORDPRESS_DB_HOST is missing
 */
export function databaseFromTaskDefinition(taskDefinition) {
  const container = taskDefinition?.containerDefinitions?.find((c) => c.name === WORDPRESS_CONTAINER);
  if (!container) {
    throw new Error(`The task definition has no ${WORDPRESS_CONTAINER} container`);
  }
  const env = Object.fromEntries((container.environment ?? []).map((e) => [e.name, e.value]));
  if (!env.WORDPRESS_DB_HOST) {
    throw new Error(`The ${WORDPRESS_CONTAINER} container has no WORDPRESS_DB_HOST`);
  }
  const passwordRef = container.secrets?.find((s) => s.name === 'WORDPRESS_DB_PASSWORD')?.valueFrom ?? null;
  return {
    ...parseHostPort(env.WORDPRESS_DB_HOST, DEFAULT_MYSQL_PORT),
    user: env.WORDPRESS_DB_USER ?? null,
    name: env.WORDPRESS_DB_NAME ?? null,
    passwordRef,
  };
}

/**
 * Parse an ECS Secrets Manager reference:
 *   arn:aws:secretsmanager:<region>:<account>:secret:<name>[:<json-key>:<version-stage>:<version-id>]
 * @param {string} valueFrom
 * @returns {{secretId: string, region: string, jsonKey: string|null, versionStage: string|null,
 *   versionId: string|null}}
 * @throws For anything that isn't a Secrets Manager ARN
 */
export function parseSecretRef(valueFrom) {
  const parts = String(valueFrom).split(':');
  if (parts.length < 7 || parts[0] !== 'arn' || parts[2] !== 'secretsmanager' || parts[5] !== 'secret') {
    throw new Error('The database password isn\'t a Secrets Manager reference');
  }
  return {
    secretId: parts.slice(0, 7).join(':'),
    region: parts[3],
    jsonKey: parts[7] || null,
    versionStage: parts[8] || null,
    versionId: parts[9] || null,
  };
}

/**
 * Fetch the value a Secrets Manager reference points to.
 * @param {object} aws - The AWS adapter
 * @param {string|null} profile
 * @param {string} valueFrom - The reference, from databaseFromTaskDefinition().passwordRef
 * @returns {Promise<string>}
 */
export async function readSecretRef(aws, profile, valueFrom) {
  const ref = parseSecretRef(valueFrom);
  const secret = await aws.getSecretString(profile, ref.region, ref.secretId, {
    versionStage: ref.versionStage, versionId: ref.versionId,
  });
  if (!ref.jsonKey) {
    return secret;
  }
  let value;
  try {
    value = JSON.parse(secret)[ref.jsonKey];
  } catch {
    throw new Error('The database secret isn\'t the JSON object its reference expects');
  }
  if (typeof value !== 'string') {
    throw new Error(`The database secret has no "${ref.jsonKey}" field`);
  }
  return value;
}

/**
 * Read the server version from MySQL's greeting, which the server sends on connect, before any
 * login. Layout: a 4-byte packet header, a protocol-version byte (10), then the server version as
 * a NUL-terminated string.
 * @param {Buffer|null} data - The first bytes received
 * @returns {{protocol: number, version: string}|null} null when it isn't a MySQL greeting
 */
export function parseMysqlGreeting(data) {
  if (!data || data.length < 6 || data[4] !== 10) {
    return null;
  }
  const end = data.indexOf(0, 5);
  if (end === -1) {
    return null;
  }
  return { protocol: data[4], version: data.subarray(5, end).toString('latin1') };
}
